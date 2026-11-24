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

            string openPath = "";
            bool backgroundMode = false;
            if (args != null)
            {
                for (int i = 0; i < args.Length; i++)
                {
                    string a = (args[i] ?? "").Trim().Trim('"');
                    if (string.IsNullOrEmpty(a)) continue;
                    if (string.Equals(a, "--background", StringComparison.OrdinalIgnoreCase) || string.Equals(a, "-bg", StringComparison.OrdinalIgnoreCase))
                    {
                        backgroundMode = true;
                    }
                    else if (string.IsNullOrEmpty(openPath))
                    {
                        openPath = a;
                    }
                }
            }
            HostLogger.Log("LightDesktop.exe baslatildi. Bg=" + backgroundMode + " OpenPath=" + openPath);
            HostLogger.ProfileStart("OpenPath=" + (string.IsNullOrEmpty(openPath) ? "(yok)" : openPath) + " | Bg=" + backgroundMode + " | PID=" + Process.GetCurrentProcess().Id);

            // Sanal Windows kabuk yollari (Denetim Masasi, Ag, Yazicilar ::{...} veya shell:...) guvenli sekilde Windows Gezgini'ne aktarilir
            if (!string.IsNullOrEmpty(openPath) && IsVirtualShellPath(openPath))
            {
                HostLogger.Log("Sanal shell yolu Explorer'a aktariliyor: " + openPath);
                try { Process.Start("explorer.exe", "\"" + openPath + "\""); } catch { }
                return 0;
            }

            // Tek örnek açıksa mevcut pencereye yolu gönder ve hemen çık
            bool forwarded = TryForwardToExistingInstance(backgroundMode ? "__PING__" : openPath);
            HostLogger.ProfileMark("TryForwardToExistingInstance -> " + forwarded);
            if (forwarded)
            {
                HostLogger.Log("Mevcut acik ornege yonlendirildi.");
                return 0;
            }

            string runtimeDir;
            try
            {
                runtimeDir = EnsureRuntimeExtracted();
                HostLogger.ProfileMark("EnsureRuntimeExtracted -> " + Path.GetFileName(runtimeDir));
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
            HostLogger.ProfileMark("CheckWebView2Safe -> " + hasWebView2 + " (" + wv2Status + ")");
            string uiHostLabel = hasWebView2 ? ("WebView2 " + wv2Status) : ("BrowserFallback (" + wv2Status + ")");
            HostLogger.Log("UI Motoru Secimi: " + uiHostLabel);

            while (true)
            {
                using (BackendManager backend = new BackendManager())
                {
                    if (!backgroundMode && hasWebView2)
                    {
                        string spawnErr;
                        bool alreadyReady;
                        if (!backend.BeginStartOrAttach(runtimeDir, uiHostLabel, out spawnErr, out alreadyReady))
                        {
                            bool retry = ShowBackendErrorDialog("LightDesktop Arka Plan Başlatılamadı", spawnErr, backend);
                            if (retry) continue;
                            return 1;
                        }

                        string asyncStartErr = "";
                        Task<string> urlTask = Task.Factory.StartNew<string>(delegate
                        {
                            string errLocal;
                            if (!alreadyReady && !backend.WaitUntilReady(out errLocal))
                            {
                                asyncStartErr = errLocal;
                                return "";
                            }
                            HostLogger.ProfileMark("Backend.StartOrAttach -> " + backend.ReadyUrl);
                            string u = backend.ReadyUrl;
                            if (!string.IsNullOrEmpty(openPath))
                            {
                                u += "/?openPath=" + Uri.EscapeDataString(openPath);
                            }
                            return u;
                        });

                        bool backendDiedUnexpectedly = false;
                        string diedOutput = "";
                        int diedCode = 0;
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
                        bool webViewOk = RunWebView2Safe("", runtimeDir, delegate(Form f) { activeUiRef = f; }, out fallbackReason, urlTask);
                        if (!string.IsNullOrEmpty(asyncStartErr))
                        {
                            bool retry = ShowBackendErrorDialog("LightDesktop Arka Plan Başlatılamadı", asyncStartErr, backend);
                            if (retry) continue;
                            return 1;
                        }
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
                            string fallbackUrl = urlTask.Result;
                            if (!string.IsNullOrEmpty(fallbackUrl)) RunBrowserFallbackWithTray(fallbackUrl, backend);
                        }
                        return 0;
                    }

                    string startErr;
                    if (!backend.StartOrAttach(runtimeDir, uiHostLabel, out startErr))
                    {
                        bool retry = ShowBackendErrorDialog("LightDesktop Arka Plan Başlatılamadı", startErr, backend);
                        if (retry) continue;
                        return 1;
                    }
                    HostLogger.ProfileMark("Backend.StartOrAttach -> " + backend.ReadyUrl);

                    string targetUrl = backend.ReadyUrl;
                    if (!string.IsNullOrEmpty(openPath))
                    {
                        targetUrl += "/?openPath=" + Uri.EscapeDataString(openPath);
                    }

                    if (backgroundMode)
                    {
                        RunPersistentBackgroundHost(backend, hasWebView2, runtimeDir);
                        return 0;
                    }

                    RunBrowserFallbackWithTray(targetUrl, backend);
                    return 0;
                }
            }
        }

        private static bool IsVirtualShellPath(string p)
        {
            if (string.IsNullOrEmpty(p)) return false;
            if (p.StartsWith("::", StringComparison.Ordinal) || p.StartsWith("shell:", StringComparison.OrdinalIgnoreCase)) return true;
            if (p.IndexOf("::{", StringComparison.Ordinal) >= 0) return true;
            return false;
        }

        private static void RunPersistentBackgroundHost(BackendManager backend, bool hasWebView2, string runtimeDir)
        {
            bool stopping = false;
            Control uiInvoker = new Control();
            IntPtr h = uiInvoker.Handle; // UI thread handle olustur
            WebView2WindowForm activeForm = null;

            Action<string> openOrFocus = delegate(string reqPath)
            {
                if (string.Equals(reqPath, "__PING__", StringComparison.Ordinal)) return;
                if (IsVirtualShellPath(reqPath))
                {
                    try { Process.Start("explorer.exe", "\"" + reqPath + "\""); } catch { }
                    return;
                }
                if (activeForm != null && !activeForm.IsDisposed)
                {
                    activeForm.OpenPathInUi(reqPath);
                    return;
                }
                string url = backend.ReadyUrl;
                if (!string.IsNullOrEmpty(reqPath))
                {
                    url += "/?openPath=" + Uri.EscapeDataString(reqPath);
                }
                if (hasWebView2)
                {
                    try
                    {
                        Form created = WebView2Launcher.CreateBackgroundWindow(url, runtimeDir, delegate
                        {
                            hasWebView2 = false;
                            OpenTargetInBrowser(url);
                        });
                        activeForm = created as WebView2WindowForm;
                        if (activeForm != null)
                        {
                            activeForm.FormClosed += delegate { activeForm = null; };
                            activeForm.Show();
                            return;
                        }
                    }
                    catch
                    {
                        hasWebView2 = false;
                    }
                }
                OpenTargetInBrowser(url);
            };

            EventWaitHandle bgReadyEvent = null;
            try { bgReadyEvent = new EventWaitHandle(false, EventResetMode.ManualReset, HostConfig.ReadyEventName); } catch { }
            NamedPipeServerStream activePipe = null;
            Thread pipeThread = new Thread(delegate()
            {
                while (!stopping)
                {
                    try
                    {
                        using (NamedPipeServerStream server = new NamedPipeServerStream(HostConfig.PipeName, PipeDirection.In, 4))
                        {
                            activePipe = server;
                            server.WaitForConnection();
                            using (StreamReader sr = new StreamReader(server, Encoding.UTF8))
                            {
                                string msg = (sr.ReadToEnd() ?? "").Trim();
                                if (!stopping && !uiInvoker.IsDisposed)
                                {
                                    uiInvoker.BeginInvoke((Action)(() => openOrFocus(msg)));
                                }
                            }
                        }
                    }
                    catch
                    {
                        if (stopping) break;
                        Thread.Sleep(250);
                    }
                }
            });
            pipeThread.IsBackground = true;
            pipeThread.Start();

            using (NotifyIcon tray = new NotifyIcon())
            {
                try { tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
                catch { tray.Icon = SystemIcons.Application; }
                tray.Text = "LightDesktop — Hazır (Çift tıkla aç)";
                tray.Visible = true;

                ContextMenuStrip menu = new ContextMenuStrip();
                menu.Items.Add("LightDesktop'ı Aç", null, delegate { openOrFocus(""); });
                menu.Items.Add("Log Klasörünü Aç", null, delegate { try { Process.Start("explorer.exe", HostLogger.CacheRoot); } catch { } });
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("Çıkış (LightDesktop'ı Kapat)", null, delegate
                {
                    stopping = true;
                    try { if (activePipe != null) activePipe.Dispose(); } catch { }
                    if (activeForm != null && !activeForm.IsDisposed) activeForm.Close();
                    Application.ExitThread();
                });
                tray.ContextMenuStrip = menu;
                tray.DoubleClick += delegate { openOrFocus(""); };
                Application.Run();
            }
            stopping = true;
            try { if (activePipe != null) activePipe.Dispose(); } catch { }
            try { if (bgReadyEvent != null) bgReadyEvent.Dispose(); } catch { }
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

        private static bool RunWebView2Safe(string url, string runtimeDir, Action<Form> onCreated, out string fallbackReason, Task<string> urlTask = null)
        {
            try
            {
                return WebView2Launcher.RunWindow(url, runtimeDir, onCreated, out fallbackReason, urlTask);
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
                EventWaitHandle ev;
                if (!EventWaitHandle.TryOpenExisting(HostConfig.ReadyEventName, out ev))
                {
                    return false;
                }
                ev.Dispose();
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
