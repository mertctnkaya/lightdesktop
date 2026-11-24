using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;


namespace LightDesktopHost
{
    internal sealed class BackendManager : IDisposable
    {
        private Process proc;
        private readonly List<string> stderrLines = new List<string>();
        private readonly List<string> stdoutLines = new List<string>();
        private readonly object ioLock = new object();
        private bool ownsProcess;
        public string ReadyUrl { get; private set; }
        public int Port { get; private set; }
        public event Action<int, string> UnexpectedExit;
        private bool intentionalStop;
        private ManualResetEventSlim pendingReadySignal;
        private string pendingDetectedUrl;
        private DateTime pendingSpawnStart;
        private bool pendingAlreadyReady;

        public string GetOutputTail()
        {
            lock (ioLock)
            {
                StringBuilder sb = new StringBuilder();
                if (stderrLines.Count > 0)
                {
                    sb.AppendLine("[STDERR]");
                    for (int i = 0; i < stderrLines.Count; i++) sb.AppendLine(stderrLines[i]);
                }
                if (stdoutLines.Count > 0)
                {
                    sb.AppendLine("[STDOUT]");
                    for (int i = 0; i < stdoutLines.Count; i++) sb.AppendLine(stdoutLines[i]);
                }
                return sb.ToString().Trim();
            }
        }

        public static bool ProbeHealth(int port, int timeoutMs)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(string.Format("http://127.0.0.1:{0}/api/health", port));
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string body = sr.ReadToEnd();
                    return body.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool IsPortFree(int port)
        {
            TcpListener listener = null;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                return true;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (listener != null) try { listener.Stop(); } catch { }
            }
        }

        private static int FindEphemeralFreePort()
        {
            TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int p = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return p;
        }

        public bool StartOrAttach(string runtimeDir, string uiHostLabel, out string errorMsg)
        {
            bool alreadyReady;
            if (!BeginStartOrAttach(runtimeDir, uiHostLabel, out errorMsg, out alreadyReady))
            {
                return false;
            }
            if (alreadyReady) return true;
            return WaitUntilReady(out errorMsg);
        }

        public bool BeginStartOrAttach(string runtimeDir, string uiHostLabel, out string errorMsg, out bool alreadyReady)
        {
            errorMsg = "";
            alreadyReady = false;
            pendingAlreadyReady = false;
            bool defaultPortFree = IsPortFree(HostConfig.DefaultPort);
            HostLogger.ProfileMark("Backend.IsPortFree(3847) -> " + defaultPortFree);
            if (!defaultPortFree)
            {
                bool probeOk = ProbeHealth(HostConfig.DefaultPort, 400);
                HostLogger.ProfileMark("Backend.ProbeHealth(3847) -> " + probeOk);
                if (probeOk)
                {
                    Port = HostConfig.DefaultPort;
                    ReadyUrl = string.Format("http://127.0.0.1:{0}", Port);
                    ownsProcess = false;
                    alreadyReady = true;
                    pendingAlreadyReady = true;
                    HostLogger.Log("Mevcut LightDesktop sunucusuna baglanildi: " + ReadyUrl);
                    return true;
                }
                Port = FindEphemeralFreePort();
            }
            else
            {
                Port = HostConfig.DefaultPort;
            }
            HostLogger.ProfileMark("Backend.PortSecildi -> " + Port);
            string nodeExe = Path.Combine(runtimeDir, "node.exe");
            string serverJs = Path.Combine(runtimeDir, "server.js");
            if (!File.Exists(nodeExe) || !File.Exists(serverJs))
            {
                errorMsg = "Node.exe veya server.js eksik: " + runtimeDir;
                return false;
            }

            lock (ioLock)
            {
                stderrLines.Clear();
                stdoutLines.Clear();
            }
            intentionalStop = false;

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            psi.Arguments = "--no-warnings \"server.js\"";
            psi.WorkingDirectory = runtimeDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.EnvironmentVariables["LD_PORTABLE"] = "1";
            psi.EnvironmentVariables["LD_EXE_PATH"] = Application.ExecutablePath;
            psi.EnvironmentVariables["LD_CACHE_ROOT"] = HostLogger.CacheRoot;
            psi.EnvironmentVariables["LD_LOG_FILE"] = HostLogger.NodeLogFile;
            psi.EnvironmentVariables["LD_PORT_AUTO"] = "1";
            psi.EnvironmentVariables["LD_UI_HOST"] = uiHostLabel ?? "Unknown";
            psi.EnvironmentVariables["LIGHTDESKTOP_PORT"] = Port.ToString();
            psi.EnvironmentVariables["LD_START_EPOCH_MS"] = HostLogger.StartupEpochMs.ToString();

            if (pendingReadySignal != null)
            {
                try { pendingReadySignal.Dispose(); } catch { }
            }
            pendingReadySignal = new ManualResetEventSlim(false);
            pendingDetectedUrl = string.Format("http://127.0.0.1:{0}", Port);
            ManualResetEventSlim localSignal = pendingReadySignal;

            proc = new Process();
            proc.StartInfo = psi;
            proc.EnableRaisingEvents = true;
            proc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (string.IsNullOrEmpty(e.Data)) return;
                lock (ioLock)
                {
                    stdoutLines.Add(e.Data);
                    if (stdoutLines.Count > 80) stdoutLines.RemoveAt(0);
                }
                if (e.Data.StartsWith("LIGHTDESKTOP_READY=", StringComparison.Ordinal))
                {
                    pendingDetectedUrl = e.Data.Substring("LIGHTDESKTOP_READY=".Length).Trim();
                    localSignal.Set();
                }
            };
            proc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (string.IsNullOrEmpty(e.Data)) return;
                lock (ioLock)
                {
                    stderrLines.Add(e.Data);
                    if (stderrLines.Count > 80) stderrLines.RemoveAt(0);
                }
            };
            proc.Exited += delegate
            {
                localSignal.Set();
                if (!intentionalStop && ownsProcess)
                {
                    int code = 0;
                    try { code = proc.ExitCode; } catch { }
                    HostLogger.Log("Node arka plan sunucusu beklenmedik sekilde kapandi. ExitCode=" + code);
                    var handler = UnexpectedExit;
                    if (handler != null) handler(code, GetOutputTail());
                }
            };

            try
            {
                if (!proc.Start())
                {
                    errorMsg = "Node sureci baslatilamadi.";
                    return false;
                }
                ownsProcess = true;
                pendingSpawnStart = DateTime.UtcNow;
                HostLogger.ProfileMark("Backend.NodeProcessSpawned (PID=" + proc.Id + ")");
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                return true;
            }
            catch (Exception ex)
            {
                errorMsg = "Node sureci baslatma hatasi: " + ex.Message;
                return false;
            }
        }

        public bool WaitUntilReady(out string errorMsg)
        {
            errorMsg = "";
            if (pendingAlreadyReady) return true;
            if (proc == null || pendingReadySignal == null)
            {
                errorMsg = "Node sureci baslatilmadi.";
                return false;
            }

            DateTime deadline = pendingSpawnStart.AddSeconds(15);
            while (DateTime.UtcNow < deadline)
            {
                if (proc.HasExited)
                {
                    errorMsg = string.Format("Arka plan sunucusu baslarken kapandi (Cikis Kodu: {0}).", proc.ExitCode);
                    return false;
                }
                if (pendingReadySignal.Wait(200))
                {
                    Uri u;
                    if (Uri.TryCreate(pendingDetectedUrl, UriKind.Absolute, out u))
                    {
                        Port = u.Port;
                        ReadyUrl = pendingDetectedUrl;
                        HostLogger.ProfileMark("Backend.LIGHTDESKTOP_READY alindi");
                        HostLogger.Log("Sunucu hazir (PID=" + proc.Id + "): " + ReadyUrl);
                        return true;
                    }
                }
                if ((DateTime.UtcNow - pendingSpawnStart).TotalMilliseconds > 1500 && ProbeHealth(Port, 400))
                {
                    ReadyUrl = string.Format("http://127.0.0.1:{0}", Port);
                    HostLogger.ProfileMark("Backend.ProbeHealthHazir");
                    HostLogger.Log("Sunucu health check ile hazir (PID=" + proc.Id + "): " + ReadyUrl);
                    return true;
                }
            }

            errorMsg = "Arka plan sunucusu 15 saniye icinde yanit vermedi.";
            Stop();
            return false;
        }

        public void Stop()
        {
            intentionalStop = true;
            if (!ownsProcess || proc == null) return;
            try
            {
                if (!proc.HasExited)
                {
                    HostLogger.Log("Node sunucusu kapatiliyor (PID=" + proc.Id + ")...");
                    proc.Kill();
                    proc.WaitForExit(1500);
                }
            }
            catch { }
            finally
            {
                try { proc.Dispose(); } catch { }
                proc = null;
                ownsProcess = false;
            }
        }

        public void Dispose()
        {
            Stop();
        }
    }
}
