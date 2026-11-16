using System;
using System.Collections.Generic;
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

[assembly: AssemblyTitle("LightDesktop")]
[assembly: AssemblyDescription("HDD Dostu Ultra Hafif Dosya Gezgini")]
[assembly: AssemblyProduct("LightDesktop")]
[assembly: AssemblyVersion("1.5.0.0")]
[assembly: AssemblyFileVersion("1.5.0.0")]

namespace LightDesktopHost
{
    internal static class HostConfig
    {
        // build-portable.ps1 tarafından __BUILD_STAMP__ güncellenebilir
        public const string BuildStamp = "__BUILD_STAMP__";
        public const string PipeName = "LightDesktop_SingleInstance_Pipe_v1";
        public const int DefaultPort = 3847;
    }

    internal static class HostLogger
    {
        private static readonly object LockObj = new object();
        private static readonly List<string> Lines = new List<string>();
        public static string CacheRoot = ResolveCacheRoot();
        public static string HostLogFile = Path.Combine(CacheRoot, "host-logs.txt");
        public static string NodeLogFile = Path.Combine(CacheRoot, "logs.txt");

        private static string ResolveCacheRoot()
        {
            string[] candidates = new string[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                Path.GetTempPath()
            };
            for (int i = 0; i < candidates.Length; i++)
            {
                if (string.IsNullOrEmpty(candidates[i])) continue;
                try
                {
                    string dir = Path.Combine(candidates[i], "LightDesktopCache");
                    Directory.CreateDirectory(dir);
                    string probe = Path.Combine(dir, ".write-probe");
                    File.WriteAllText(probe, "1");
                    File.Delete(probe);
                    return dir;
                }
                catch { }
            }
            return Path.Combine(Path.GetTempPath(), "LightDesktopCache");
        }

        public static void Log(string msg)
        {
            string line = string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff}] {1}", DateTime.Now, msg);
            lock (LockObj)
            {
                Lines.Add(line);
                if (Lines.Count > 250) Lines.RemoveAt(0);
                try
                {
                    if (File.Exists(HostLogFile) && new FileInfo(HostLogFile).Length > 2 * 1024 * 1024)
                    {
                        string prev = HostLogFile + ".prev";
                        if (File.Exists(prev)) File.Delete(prev);
                        File.Move(HostLogFile, prev);
                    }
                    File.AppendAllText(HostLogFile, line + Environment.NewLine, Encoding.UTF8);
                }
                catch { }
            }
        }

        public static string GetAllHostLogs()
        {
            lock (LockObj)
            {
                return string.Join(Environment.NewLine, Lines.ToArray());
            }
        }

        public static string ReadTail(string filePath, int maxLines)
        {
            try
            {
                if (!File.Exists(filePath)) return "(dosya henüz oluşturulmadı)";
                string[] all = File.ReadAllLines(filePath, Encoding.UTF8);
                int start = Math.Max(0, all.Length - maxLines);
                return string.Join(Environment.NewLine, all, start, all.Length - start);
            }
            catch (Exception ex)
            {
                return "(okunamadı: " + ex.Message + ")";
            }
        }
    }

    internal static class NativeWin32
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr LoadLibrary(string lpFileName);

        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        public static void EnableDarkTitleBar(IntPtr handle)
        {
            if (handle == IntPtr.Zero) return;
            try
            {
                int val = 1;
                if (DwmSetWindowAttribute(handle, 20, ref val, 4) != 0)
                {
                    DwmSetWindowAttribute(handle, 19, ref val, 4);
                }
            }
            catch { }
        }
    }

    internal sealed class CrashReportForm : Form
    {
        private readonly string fullReportText;
        public bool WantsRetry { get; private set; }

        public CrashReportForm(string title, string summary, string detailsText, bool allowRetry)
        {
            this.fullReportText = detailsText ?? "";
            this.Text = title;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Size = new Size(780, 560);
            this.MinimumSize = new Size(600, 420);
            this.BackColor = Color.FromArgb(24, 24, 24);
            this.ForeColor = Color.FromArgb(238, 238, 238);
            this.Font = new Font("Segoe UI", 9.5F);
            try { this.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            Label lblHead = new Label();
            lblHead.Text = title;
            lblHead.Font = new Font("Segoe UI Semibold", 12F, FontStyle.Bold);
            lblHead.ForeColor = Color.FromArgb(255, 130, 125);
            lblHead.Dock = DockStyle.Top;
            lblHead.Padding = new Padding(14, 12, 14, 4);
            lblHead.AutoSize = true;

            Label lblSub = new Label();
            lblSub.Text = summary;
            lblSub.ForeColor = Color.FromArgb(215, 215, 215);
            lblSub.Dock = DockStyle.Top;
            lblSub.Padding = new Padding(14, 0, 14, 10);
            lblSub.MaximumSize = new Size(740, 0);
            lblSub.AutoSize = true;

            TextBox txtDetails = new TextBox();
            txtDetails.Multiline = true;
            txtDetails.ReadOnly = true;
            txtDetails.ScrollBars = ScrollBars.Both;
            txtDetails.WordWrap = false;
            txtDetails.BackColor = Color.FromArgb(14, 14, 14);
            txtDetails.ForeColor = Color.FromArgb(212, 220, 230);
            txtDetails.Font = new Font("Consolas", 9F);
            txtDetails.BorderStyle = BorderStyle.FixedSingle;
            txtDetails.Dock = DockStyle.Fill;
            txtDetails.Text = this.fullReportText;

            Panel panelText = new Panel();
            panelText.Dock = DockStyle.Fill;
            panelText.Padding = new Padding(14, 0, 14, 10);
            panelText.Controls.Add(txtDetails);

            FlowLayoutPanel btnBar = new FlowLayoutPanel();
            btnBar.Dock = DockStyle.Bottom;
            btnBar.FlowDirection = FlowDirection.RightToLeft;
            btnBar.Height = 48;
            btnBar.Padding = new Padding(14, 8, 14, 8);
            btnBar.BackColor = Color.FromArgb(30, 30, 30);

            Button btnClose = MakeBtn("Kapat", Color.FromArgb(52, 52, 52));
            btnClose.Click += delegate { this.DialogResult = DialogResult.Cancel; this.Close(); };
            btnBar.Controls.Add(btnClose);

            if (allowRetry)
            {
                Button btnRetry = MakeBtn("Yeniden Başlat", Color.FromArgb(0, 114, 210));
                btnRetry.Click += delegate { this.WantsRetry = true; this.DialogResult = DialogResult.Retry; this.Close(); };
                btnBar.Controls.Add(btnRetry);
            }

            Button btnOpenLogs = MakeBtn("Log Klasörünü Aç", Color.FromArgb(46, 46, 46));
            btnOpenLogs.Click += delegate
            {
                try { Process.Start("explorer.exe", HostLogger.CacheRoot); } catch { }
            };
            btnBar.Controls.Add(btnOpenLogs);

            Button btnCopy = MakeBtn("Hata Raporunu Kopyala (Geliştiriciye Gönder)", Color.FromArgb(35, 110, 62));
            btnCopy.Width = 290;
            btnCopy.Click += delegate
            {
                try
                {
                    Clipboard.SetText(this.fullReportText);
                    btnCopy.Text = "Panoya Kopyalandı!";
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Panoya kopyalanamadı: " + ex.Message);
                }
            };
            btnBar.Controls.Add(btnCopy);

            this.Controls.Add(panelText);
            this.Controls.Add(lblSub);
            this.Controls.Add(lblHead);
            this.Controls.Add(btnBar);
            this.Shown += delegate { NativeWin32.EnableDarkTitleBar(this.Handle); };
        }

        private static Button MakeBtn(string text, Color bg)
        {
            Button b = new Button();
            b.Text = text;
            b.AutoSize = false;
            b.Size = new Size(140, 30);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Color.FromArgb(72, 72, 72);
            b.BackColor = bg;
            b.ForeColor = Color.White;
            b.Cursor = Cursors.Hand;
            b.Margin = new Padding(6, 0, 0, 0);
            return b;
        }
    }

    internal sealed class SplashForm : Form
    {
        private readonly Label lbl;
        public SplashForm(string initialText)
        {
            this.FormBorderStyle = FormBorderStyle.FixedSingle;
            this.ControlBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Size = new Size(420, 110);
            this.BackColor = Color.FromArgb(24, 24, 24);
            this.ForeColor = Color.FromArgb(238, 238, 238);
            this.Text = "LightDesktop";
            try { this.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            lbl = new Label();
            lbl.Text = initialText;
            lbl.Dock = DockStyle.Fill;
            lbl.TextAlign = ContentAlignment.MiddleCenter;
            lbl.Font = new Font("Segoe UI", 10F);
            this.Controls.Add(lbl);
            this.Shown += delegate { NativeWin32.EnableDarkTitleBar(this.Handle); };
        }

        public void UpdateStatus(string text)
        {
            if (this.IsDisposed) return;
            if (this.InvokeRequired)
            {
                try { this.BeginInvoke((Action)(() => UpdateStatus(text))); } catch { }
                return;
            }
            lbl.Text = text;
            lbl.Refresh();
        }
    }

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
            errorMsg = "";
            if (ProbeHealth(HostConfig.DefaultPort, 700))
            {
                Port = HostConfig.DefaultPort;
                ReadyUrl = string.Format("http://127.0.0.1:{0}", Port);
                ownsProcess = false;
                HostLogger.Log("Mevcut LightDesktop sunucusuna baglanildi: " + ReadyUrl);
                return true;
            }

            Port = IsPortFree(HostConfig.DefaultPort) ? HostConfig.DefaultPort : FindEphemeralFreePort();
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

            ManualResetEventSlim readySignal = new ManualResetEventSlim(false);
            string detectedUrl = string.Format("http://127.0.0.1:{0}", Port);

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
                    detectedUrl = e.Data.Substring("LIGHTDESKTOP_READY=".Length).Trim();
                    readySignal.Set();
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
                readySignal.Set();
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
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                errorMsg = "Node sureci baslatma hatasi: " + ex.Message;
                return false;
            }

            DateTime deadline = DateTime.UtcNow.AddSeconds(15);
            while (DateTime.UtcNow < deadline)
            {
                if (proc.HasExited)
                {
                    errorMsg = string.Format("Arka plan sunucusu baslarken kapandi (Cikis Kodu: {0}).", proc.ExitCode);
                    return false;
                }
                if (readySignal.Wait(150))
                {
                    Uri u;
                    if (Uri.TryCreate(detectedUrl, UriKind.Absolute, out u))
                    {
                        Port = u.Port;
                        ReadyUrl = detectedUrl;
                        HostLogger.Log("Sunucu hazir (PID=" + proc.Id + "): " + ReadyUrl);
                        return true;
                    }
                }
                if (ProbeHealth(Port, 400))
                {
                    ReadyUrl = string.Format("http://127.0.0.1:{0}", Port);
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

    // WebView2 tipi ayri sinifta tutulur; JIT eksik DLL varsa bile ana akis cokmeden yakalar.
    internal sealed class WebView2WindowForm : Form
    {
        private readonly WebView2 webView;
        private readonly string initialUrl;
        private readonly string boundsFile;
        private readonly Action<string> onFatalFallback;
        private int rendererCrashCount;
        private System.Windows.Forms.Timer saveBoundsTimer;
        private NamedPipeServerStream pipeServer;
        private bool pipeStopping;

        public WebView2WindowForm(string url, string cacheRoot, Action<string> onFallbackRequested)
        {
            this.initialUrl = url;
            this.boundsFile = Path.Combine(cacheRoot, "window-bounds.json");
            this.onFatalFallback = onFallbackRequested;

            this.Text = "LightDesktop — HDD Dostu Dosya Gezgini";
            this.BackColor = Color.FromArgb(24, 24, 24);
            this.ForeColor = Color.FromArgb(238, 238, 238);
            this.MinimumSize = new Size(640, 420);
            try { this.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            ApplySavedBounds();

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = Color.FromArgb(24, 24, 24);
            this.Controls.Add(webView);

            saveBoundsTimer = new System.Windows.Forms.Timer();
            saveBoundsTimer.Interval = 450;
            saveBoundsTimer.Tick += delegate
            {
                saveBoundsTimer.Stop();
                SaveCurrentBounds();
            };

            this.Resize += delegate { ScheduleSaveBounds(); };
            this.Move += delegate { ScheduleSaveBounds(); };
            this.Shown += OnFormShown;
            this.FormClosing += delegate
            {
                pipeStopping = true;
                try { if (pipeServer != null) pipeServer.Dispose(); } catch { }
                SaveCurrentBounds();
            };
        }

        private void ApplySavedBounds()
        {
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Size = new Size(1360, 820);
            try
            {
                if (!File.Exists(boundsFile)) return;
                JavaScriptSerializer js = new JavaScriptSerializer();
                Dictionary<string, object> obj = js.Deserialize<Dictionary<string, object>>(File.ReadAllText(boundsFile, Encoding.UTF8));
                if (obj == null) return;
                int w = obj.ContainsKey("width") ? Convert.ToInt32(obj["width"]) : 1360;
                int h = obj.ContainsKey("height") ? Convert.ToInt32(obj["height"]) : 820;
                int x = obj.ContainsKey("x") ? Convert.ToInt32(obj["x"]) : 80;
                int y = obj.ContainsKey("y") ? Convert.ToInt32(obj["y"]) : 60;
                if (w >= 500 && h >= 360)
                {
                    this.Size = new Size(w, h);
                    bool onScreen = false;
                    foreach (Screen scr in Screen.AllScreens)
                    {
                        Rectangle wa = scr.WorkingArea;
                        if (x >= wa.Left - 80 && x < wa.Right - 80 && y >= wa.Top - 40 && y < wa.Bottom - 80)
                        {
                            onScreen = true;
                            break;
                        }
                    }
                    if (onScreen)
                    {
                        this.StartPosition = FormStartPosition.Manual;
                        this.Location = new Point(x, y);
                    }
                }
            }
            catch { }
        }

        private void ScheduleSaveBounds()
        {
            if (this.WindowState != FormWindowState.Normal) return;
            saveBoundsTimer.Stop();
            saveBoundsTimer.Start();
        }

        private void SaveCurrentBounds()
        {
            try
            {
                Rectangle r = this.WindowState == FormWindowState.Normal ? this.Bounds : this.RestoreBounds;
                if (r.Width < 500 || r.Height < 360) return;
                JavaScriptSerializer js = new JavaScriptSerializer();
                string json = js.Serialize(new { x = r.X, y = r.Y, width = r.Width, height = r.Height });
                File.WriteAllText(boundsFile, json, Encoding.UTF8);
            }
            catch { }
        }

        public void OpenPathInUi(string folderPath)
        {
            if (this.IsDisposed) return;
            if (this.InvokeRequired)
            {
                try { this.BeginInvoke((Action)(() => OpenPathInUi(folderPath))); } catch { }
                return;
            }
            if (this.WindowState == FormWindowState.Minimized) NativeWin32.ShowWindow(this.Handle, 9);
            NativeWin32.SetForegroundWindow(this.Handle);
            this.Activate();
            if (!string.IsNullOrEmpty(folderPath) && webView != null && webView.CoreWebView2 != null)
            {
                string escaped = folderPath.Replace("\\", "\\\\").Replace("'", "\\'");
                string script = string.Format("if (typeof createTab === 'function') createTab('{0}', true);", escaped);
                webView.CoreWebView2.ExecuteScriptAsync(script);
            }
        }

        private void StartSingleInstancePipeServer()
        {
            Thread t = new Thread(delegate()
            {
                while (!pipeStopping)
                {
                    try
                    {
                        using (NamedPipeServerStream server = new NamedPipeServerStream(HostConfig.PipeName, PipeDirection.In, 4))
                        {
                            pipeServer = server;
                            server.WaitForConnection();
                            using (StreamReader sr = new StreamReader(server, Encoding.UTF8))
                            {
                                string path = (sr.ReadToEnd() ?? "").Trim();
                                OpenPathInUi(path);
                            }
                        }
                    }
                    catch
                    {
                        if (pipeStopping) break;
                        Thread.Sleep(250);
                    }
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        private async void OnFormShown(object sender, EventArgs e)
        {
            NativeWin32.EnableDarkTitleBar(this.Handle);
            StartSingleInstancePipeServer();
            try
            {
                string userData = Path.Combine(HostLogger.CacheRoot, "WebView2Data");
                Directory.CreateDirectory(userData);
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userData);
                await webView.EnsureCoreWebView2Async(env);
                if (webView.CoreWebView2 == null)
                {
                    TriggerFallback("CoreWebView2 bos dondu.");
                    return;
                }

                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.Settings.IsZoomControlEnabled = false;

                webView.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs ev)
                {
                    if (!string.IsNullOrEmpty(ev.Uri) && !ev.Uri.StartsWith("http://127.0.0.1:", StringComparison.OrdinalIgnoreCase))
                    {
                        ev.Handled = true;
                        try { Process.Start(ev.Uri); } catch { }
                    }
                };

                webView.CoreWebView2.DocumentTitleChanged += delegate
                {
                    if (!string.IsNullOrEmpty(webView.CoreWebView2.DocumentTitle))
                    {
                        this.Text = webView.CoreWebView2.DocumentTitle;
                    }
                };

                webView.CoreWebView2.ProcessFailed += delegate(object s, CoreWebView2ProcessFailedEventArgs ev)
                {
                    HostLogger.Log("WebView2 ProcessFailed: " + ev.ProcessFailedKind + " | Reason=" + ev.Reason);
                    rendererCrashCount++;
                    if (rendererCrashCount <= 1 && ev.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
                    {
                        try { webView.Reload(); return; } catch { }
                    }
                    TriggerFallback("WebView2 surec hatasi (" + ev.ProcessFailedKind + ")");
                };

                webView.CoreWebView2.Navigate(initialUrl);
                HostLogger.Log("WebView2 penceresi basariyla acildi: " + initialUrl);
            }
            catch (Exception ex)
            {
                HostLogger.Log("WebView2 baslatilamadi: " + ex);
                TriggerFallback(ex.Message);
            }
        }

        private void TriggerFallback(string reason)
        {
            if (onFatalFallback != null)
            {
                this.Hide();
                onFatalFallback(reason);
                this.Close();
            }
        }
    }

    internal static class WebView2Launcher
    {
        public static bool IsRuntimeAvailable(string runtimeDir, out string versionOrReason)
        {
            try
            {
                string loader = Path.Combine(runtimeDir, "WebView2Loader.dll");
                if (File.Exists(loader)) NativeWin32.LoadLibrary(loader);
                string ver = CoreWebView2Environment.GetAvailableBrowserVersionString();
                if (string.IsNullOrEmpty(ver))
                {
                    versionOrReason = "WebView2 Runtime bulunamadi";
                    return false;
                }
                versionOrReason = ver;
                return true;
            }
            catch (Exception ex)
            {
                versionOrReason = ex.Message;
                return false;
            }
        }

        public static bool RunWindow(string url, string runtimeDir, Action<Form> onCreated, out string fallbackReason)
        {
            string reasonLocal = "";
            bool needFallback = false;
            using (WebView2WindowForm form = new WebView2WindowForm(url, HostLogger.CacheRoot, delegate(string r)
            {
                reasonLocal = r;
                needFallback = true;
            }))
            {
                if (onCreated != null) onCreated(form);
                Application.Run(form);
            }
            fallbackReason = reasonLocal;
            return !needFallback;
        }
    }

    internal static class Program
    {
        private static string RuntimeBaseDir
        {
            get { return Path.Combine(HostLogger.CacheRoot == Path.GetTempPath() ? Path.GetTempPath() : Path.GetDirectoryName(HostLogger.CacheRoot), "LightDesktopRuntime"); }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
            {
                HandleFatalCrash("Arayüz İş Parçacığı Hatası", e.Exception, null);
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                HandleFatalCrash("Kritik Uygulama Hatası", e.ExceptionObject as Exception ?? new Exception(Convert.ToString(e.ExceptionObject)), null);
            };

            string openPath = (args != null && args.Length > 0) ? (args[0] ?? "").Trim().Trim('"') : "";
            HostLogger.Log("LightDesktop.exe baslatildi. ArgsCount=" + (args == null ? 0 : args.Length) + " OpenPath=" + openPath);

            // Tek örnek açıksa mevcut pencereye yolu gönder ve hemen çık
            if (TryForwardToExistingInstance(openPath))
            {
                HostLogger.Log("Mevcut acik pencereye yonlendirildi.");
                return 0;
            }

            string runtimeDir;
            try
            {
                runtimeDir = EnsureRuntimeExtracted();
            }
            catch (Exception ex)
            {
                HandleFatalCrash("Portable Paket Çıkarılamadı", ex, "Antivirüs kilidi veya disk alanı yetersizliği olabilir.");
                return 1;
            }

            // WebView2 DLL'lerini yalnızca runtimeDir'den yükle (EXE yanına DLL kopyalamadan)
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs resolveArgs)
            {
                try
                {
                    string shortName = new AssemblyName(resolveArgs.Name).Name + ".dll";
                    string candidate = Path.Combine(runtimeDir, shortName);
                    if (File.Exists(candidate)) return Assembly.LoadFrom(candidate);
                }
                catch { }
                return null;
            };

            string wv2Status;
            bool hasWebView2 = CheckWebView2Safe(runtimeDir, out wv2Status);
            string uiHostLabel = hasWebView2 ? ("WebView2 " + wv2Status) : ("BrowserFallback (" + wv2Status + ")");
            HostLogger.Log("UI Motoru Secimi: " + uiHostLabel);

            while (true)
            {
                using (BackendManager backend = new BackendManager())
                {
                    string startErr;
                    if (!backend.StartOrAttach(runtimeDir, uiHostLabel, out startErr))
                    {
                        bool retry = ShowBackendErrorDialog("LightDesktop Arka Plan Başlatılamadı", startErr, backend);
                        if (retry) continue;
                        return 1;
                    }

                    string targetUrl = backend.ReadyUrl;
                    if (!string.IsNullOrEmpty(openPath))
                    {
                        targetUrl += "/?openPath=" + Uri.EscapeDataString(openPath);
                    }

                    bool backendDiedUnexpectedly = false;
                    string diedOutput = "";
                    int diedCode = 0;

                    if (hasWebView2)
                    {
                        Form activeUiRef = null;
                        backend.UnexpectedExit += delegate(int code, string outTail)
                        {
                            backendDiedUnexpectedly = true;
                            diedCode = code;
                            diedOutput = outTail;
                            try
                            {
                                if (activeUiRef != null && !activeUiRef.IsDisposed)
                                {
                                    activeUiRef.BeginInvoke((Action)(() => activeUiRef.Close()));
                                }
                            }
                            catch { }
                        };

                        string fallbackReason;
                        bool webViewOk = RunWebView2Safe(targetUrl, runtimeDir, delegate(Form f) { activeUiRef = f; }, out fallbackReason);
                        if (backendDiedUnexpectedly)
                        {
                            bool retry = ShowBackendErrorDialog(
                                "Arka Plan Sunucusu Beklenmedik Şekilde Durdu",
                                "Node.js sunucusu çalışırken kapandı (Çıkış Kodu: " + diedCode + ").",
                                backend,
                                diedOutput
                            );
                            if (retry) continue;
                            return 1;
                        }
                        if (!webViewOk)
                        {
                            HostLogger.Log("WebView2 fallback tetiklendi: " + fallbackReason);
                            hasWebView2 = false;
                            RunBrowserFallbackWithTray(targetUrl, backend);
                        }
                        return 0;
                    }
                    else
                    {
                        RunBrowserFallbackWithTray(targetUrl, backend);
                        return 0;
                    }
                }
            }
        }

        private static bool CheckWebView2Safe(string runtimeDir, out string status)
        {
            try
            {
                return WebView2Launcher.IsRuntimeAvailable(runtimeDir, out status);
            }
            catch (Exception ex)
            {
                status = ex.Message;
                return false;
            }
        }

        private static bool RunWebView2Safe(string url, string runtimeDir, Action<Form> onCreated, out string fallbackReason)
        {
            try
            {
                return WebView2Launcher.RunWindow(url, runtimeDir, onCreated, out fallbackReason);
            }
            catch (Exception ex)
            {
                HostLogger.Log("WebView2 calisma hatasi: " + ex);
                fallbackReason = ex.Message;
                return false;
            }
        }

        private static bool TryForwardToExistingInstance(string openPath)
        {
            try
            {
                using (NamedPipeClientStream client = new NamedPipeClientStream(".", HostConfig.PipeName, PipeDirection.Out))
                {
                    client.Connect(350);
                    using (StreamWriter sw = new StreamWriter(client, Encoding.UTF8))
                    {
                        sw.Write(openPath ?? "");
                        sw.Flush();
                    }
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private static string EnsureRuntimeExtracted()
        {
            string stamp = HostConfig.BuildStamp;
            if (string.IsNullOrEmpty(stamp) || stamp == ("__BUILD_" + "STAMP__"))
            {
                stamp = File.GetLastWriteTimeUtc(Application.ExecutablePath).Ticks.ToString();
            }

            string baseRoot = RuntimeBaseDir;
            Directory.CreateDirectory(baseRoot);
            string targetDir = Path.Combine(baseRoot, stamp);
            string readyFile = Path.Combine(targetDir, ".ready");

            if (File.Exists(readyFile)
                && File.Exists(Path.Combine(targetDir, "node.exe"))
                && File.Exists(Path.Combine(targetDir, "server.js"))
                && File.Exists(Path.Combine(targetDir, "indexer-and-thumbs.js"))
                && File.Exists(Path.Combine(targetDir, "public", "index.html")))
            {
                HostLogger.Log("Onbellek runtime hazir: " + targetDir);
                return targetDir;
            }

            // Disk alani kontrolu (en az 180 MB bos yer)
            try
            {
                DriveInfo di = new DriveInfo(Path.GetPathRoot(baseRoot));
                if (di.AvailableFreeSpace < 180L * 1024L * 1024L)
                {
                    throw new IOException(string.Format(
                        "{0} surucusunde yeterli bos alan yok (En az 180 MB gerekli, mevcut: {1} MB).",
                        di.Name,
                        di.AvailableFreeSpace / (1024L * 1024L)
                    ));
                }
            }
            catch (IOException) { throw; }
            catch { }

            SplashForm splash = new SplashForm("LightDesktop ilk kullanım için hazırlanıyor...");
            splash.Show();
            Application.DoEvents();

            string staging = Path.Combine(baseRoot, ".staging-" + Process.GetCurrentProcess().Id);
            try
            {
                if (Directory.Exists(staging)) Directory.Delete(staging, true);
                Directory.CreateDirectory(staging);

                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream resStream = asm.GetManifestResourceStream("LightDesktop.Payload.zip"))
                {
                    if (resStream == null)
                    {
                        throw new InvalidOperationException("Gömülü uygulama paketi (LightDesktop.Payload.zip) EXE içinde bulunamadı.");
                    }
                    using (ZipArchive zip = new ZipArchive(resStream, ZipArchiveMode.Read))
                    {
                        foreach (ZipArchiveEntry entry in zip.Entries)
                        {
                            string destPath = Path.GetFullPath(Path.Combine(staging, entry.FullName));
                            if (!destPath.StartsWith(Path.GetFullPath(staging), StringComparison.OrdinalIgnoreCase)) continue;
                            if (string.IsNullOrEmpty(entry.Name))
                            {
                                Directory.CreateDirectory(destPath);
                                continue;
                            }
                            Directory.CreateDirectory(Path.GetDirectoryName(destPath));
                            entry.ExtractToFile(destPath, true);
                        }
                    }
                }

                File.WriteAllText(Path.Combine(staging, ".ready"), stamp, Encoding.UTF8);
                if (Directory.Exists(targetDir)) Directory.Delete(targetDir, true);
                Directory.Move(staging, targetDir);

                // Eski runtime surumlerini temizle
                try
                {
                    foreach (string oldDir in Directory.GetDirectories(baseRoot))
                    {
                        string name = Path.GetFileName(oldDir);
                        if (!string.Equals(name, stamp, StringComparison.OrdinalIgnoreCase))
                        {
                            try { Directory.Delete(oldDir, true); } catch { }
                        }
                    }
                }
                catch { }

                HostLogger.Log("Runtime basariyla cikarildi: " + targetDir);
                return targetDir;
            }
            finally
            {
                splash.Close();
                splash.Dispose();
                try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { }
            }
        }

        private static string FindChromiumBrowser()
        {
            string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string[] candidates = new string[]
            {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                Path.Combine(localApp, @"Google\Chrome\Application\chrome.exe"),
                @"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
                @"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
                Path.Combine(localApp, @"Vivaldi\Application\vivaldi.exe"),
                @"C:\Program Files\Vivaldi\Application\vivaldi.exe",
                Path.Combine(localApp, @"Programs\Opera\opera.exe")
            };
            for (int i = 0; i < candidates.Length; i++)
            {
                if (!string.IsNullOrEmpty(candidates[i]) && File.Exists(candidates[i])) return candidates[i];
            }
            return null;
        }

        private static void OpenTargetInBrowser(string url)
        {
            string browser = FindChromiumBrowser();
            if (!string.IsNullOrEmpty(browser))
            {
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = browser,
                        Arguments = string.Format("--app=\"{0}\" --new-window --window-size=1360,820", url),
                        UseShellExecute = false
                    });
                    HostLogger.Log("Tarayici app modu acildi: " + Path.GetFileName(browser));
                    return;
                }
                catch { }
            }
            try
            {
                Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
                HostLogger.Log("Varsayilan tarayici acildi: " + url);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Tarayıcı açılamadı (" + ex.Message + "). Lütfen tarayıcınızdan şu adresi açın:\n" + url, "LightDesktop");
            }
        }

        private static void RunBrowserFallbackWithTray(string url, BackendManager backend)
        {
            OpenTargetInBrowser(url);

            using (NotifyIcon tray = new NotifyIcon())
            {
                try { tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
                catch { tray.Icon = SystemIcons.Application; }
                tray.Text = "LightDesktop Çalışıyor (Tarayıcı Modu)";
                tray.Visible = true;

                ContextMenuStrip menu = new ContextMenuStrip();
                menu.Items.Add("LightDesktop Penceresini Aç", null, delegate { OpenTargetInBrowser(url); });
                menu.Items.Add("Log Klasörünü Aç", null, delegate { try { Process.Start("explorer.exe", HostLogger.CacheRoot); } catch { } });
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("Çıkış (Arka Plan Sunucusunu Kapat)", null, delegate { Application.ExitThread(); });
                tray.ContextMenuStrip = menu;
                tray.DoubleClick += delegate { OpenTargetInBrowser(url); };
                tray.ShowBalloonTip(3500, "LightDesktop Tarayıcı Modunda Açıldı", "WebView2 bulunamadığı için tarayıcıda açıldı. Kapatmak için sistem tepsisindeki ikona sağ tıklayın.", ToolTipIcon.Info);

                Application.Run();
            }
        }

        private static string BuildFullDiagnosticsReport(string summary, Exception ex, string extraTail)
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("=== LIGHTDESKTOP HATA & TESHIS RAPORU ===");
            sb.AppendLine("Tarih: " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            sb.AppendLine("Uygulama: " + Application.ExecutablePath);
            sb.AppendLine("Surum / BuildStamp: 1.5.0 / " + HostConfig.BuildStamp);
            sb.AppendLine("OS: " + Environment.OSVersion + " | 64-bit OS: " + Environment.Is64BitOperatingSystem + " | 64-bit Process: " + Environment.Is64BitProcess);
            sb.AppendLine("CLR: " + Environment.Version);
            sb.AppendLine("CacheRoot: " + HostLogger.CacheRoot);
            sb.AppendLine("Ozet: " + summary);
            if (ex != null)
            {
                sb.AppendLine();
                sb.AppendLine("--- EXCEPTION ---");
                sb.AppendLine(ex.ToString());
            }
            if (!string.IsNullOrEmpty(extraTail))
            {
                sb.AppendLine();
                sb.AppendLine("--- SUNUCU CIKTISI ---");
                sb.AppendLine(extraTail);
            }
            string crashLast = HostLogger.ReadTail(Path.Combine(HostLogger.CacheRoot, "crash-last.txt"), 60);
            if (!string.IsNullOrEmpty(crashLast) && crashLast != "(dosya henüz oluşturulmadı)")
            {
                sb.AppendLine();
                sb.AppendLine("--- CRASH-LAST.TXT ---");
                sb.AppendLine(crashLast);
            }
            sb.AppendLine();
            sb.AppendLine("--- HOST LOGLARI ---");
            sb.AppendLine(HostLogger.GetAllHostLogs());
            sb.AppendLine();
            sb.AppendLine("--- LOGS.TXT SON SATIRLAR ---");
            sb.AppendLine(HostLogger.ReadTail(HostLogger.NodeLogFile, 80));
            return sb.ToString();
        }

        private static bool ShowBackendErrorDialog(string title, string summary, BackendManager backend, string explicitTail = "")
        {
            string tail = !string.IsNullOrEmpty(explicitTail) ? explicitTail : (backend != null ? backend.GetOutputTail() : "");
            string report = BuildFullDiagnosticsReport(summary, null, tail);
            HostLogger.Log("Hata penceresi gosteriliyor: " + summary);
            using (CrashReportForm dlg = new CrashReportForm(title, summary + "\n\nAşağıdaki tam teknik raporu geliştiriciye gönderebilirsiniz:", report, true))
            {
                dlg.ShowDialog();
                return dlg.WantsRetry;
            }
        }

        private static void HandleFatalCrash(string title, Exception ex, string hint)
        {
            HostLogger.Log("FATAL CRASH: " + (ex != null ? ex.ToString() : title));
            string summary = (ex != null ? ex.Message : title) + (string.IsNullOrEmpty(hint) ? "" : "\n" + hint);
            string report = BuildFullDiagnosticsReport(summary, ex, null);
            try
            {
                using (CrashReportForm dlg = new CrashReportForm(title, summary, report, false))
                {
                    dlg.ShowDialog();
                }
            }
            catch
            {
                MessageBox.Show(summary + "\n\n" + report, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
