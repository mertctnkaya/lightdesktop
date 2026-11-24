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
    internal sealed class WebView2WindowForm : Form
    {
        private readonly WebView2 webView;
        private readonly string initialUrl;
        private readonly Task<string> pendingUrlTask;
        private readonly string boundsFile;
        private readonly Action<string> onFatalFallback;
        private int rendererCrashCount;
        private System.Windows.Forms.Timer saveBoundsTimer;
        private NamedPipeServerStream pipeServer;
        private EventWaitHandle readyEvent;
        private bool pipeStopping;
        public bool EnablePipeServer = true;

        public WebView2WindowForm(string url, string cacheRoot, Action<string> onFallbackRequested, Task<string> urlTask = null)
        {
            this.initialUrl = url;
            this.pendingUrlTask = urlTask;
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
            webView.AllowExternalDrop = true;
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
                try { if (readyEvent != null) readyEvent.Dispose(); } catch { }
                SaveCurrentBounds();
            };
            HostLogger.ProfileMark("WebView2WindowForm ctor tamamlandi");
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
            try
            {
                readyEvent = new EventWaitHandle(false, EventResetMode.ManualReset, HostConfig.ReadyEventName);
            }
            catch { }
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
            HostLogger.ProfileMark("WebView2WindowForm.Shown tetiklendi");
            NativeWin32.EnableDarkTitleBar(this.Handle);
            if (EnablePipeServer) StartSingleInstancePipeServer();
            try
            {
                string userData = Path.Combine(HostLogger.CacheRoot, "WebView2Data");
                Directory.CreateDirectory(userData);
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userData);
                HostLogger.ProfileMark("CoreWebView2Environment.CreateAsync tamamlandi");
                await webView.EnsureCoreWebView2Async(env);
                HostLogger.ProfileMark("EnsureCoreWebView2Async tamamlandi");
                if (webView.CoreWebView2 == null)
                {
                    TriggerFallback("CoreWebView2 bos dondu.");
                    return;
                }

                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
                webView.CoreWebView2.Settings.IsWebMessageEnabled = true;
                webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

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

                try
                {
                    string cacheStampFile = Path.Combine(userData, ".cache-stamp");
                    string curStamp = HostConfig.BuildStamp ?? "";
                    string prevStamp = File.Exists(cacheStampFile) ? File.ReadAllText(cacheStampFile, Encoding.UTF8).Trim() : "";
                    if (!string.Equals(prevStamp, curStamp, StringComparison.Ordinal))
                    {
                        await webView.CoreWebView2.CallDevToolsProtocolMethodAsync("Network.clearBrowserCache", "{}");
                        File.WriteAllText(cacheStampFile, curStamp, Encoding.UTF8);
                    }
                }
                catch { }

                string navUrl = initialUrl;
                if (pendingUrlTask != null)
                {
                    navUrl = await pendingUrlTask;
                    if (string.IsNullOrEmpty(navUrl))
                    {
                        this.Close();
                        return;
                    }
                }
                webView.CoreWebView2.Navigate(navUrl);
                HostLogger.ProfileMark("CoreWebView2.Navigate cagrildi");
                HostLogger.Log("WebView2 penceresi basariyla acildi: " + navUrl);
            }
            catch (Exception ex)
            {
                HostLogger.Log("WebView2 baslatilamadi: " + ex);
                TriggerFallback(ex.Message);
            }
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                string rawJson = e.WebMessageAsJson;
                if (string.IsNullOrEmpty(rawJson)) return;
                JavaScriptSerializer js = new JavaScriptSerializer();
                Dictionary<string, object> msg = js.Deserialize<Dictionary<string, object>>(rawJson);
                if (msg == null || !msg.ContainsKey("type")) return;
                string type = Convert.ToString(msg["type"]);

                if (string.Equals(type, "startNativeFileDrag", StringComparison.Ordinal))
                {
                    StringCollection sc = new StringCollection();
                    List<string> validList = new List<string>();
                    object rawPathsObj = msg.ContainsKey("paths") ? msg["paths"] : null;
                    System.Collections.IEnumerable rawEnum = rawPathsObj as System.Collections.IEnumerable;
                    if (rawEnum != null)
                    {
                        foreach (object item in rawEnum)
                        {
                            string p = Convert.ToString(item);
                            if (!string.IsNullOrEmpty(p) && (File.Exists(p) || Directory.Exists(p)))
                            {
                                sc.Add(p);
                                validList.Add(p);
                            }
                        }
                    }

                    DragDropEffects eff = DragDropEffects.None;
                    if (sc.Count > 0 && (Control.MouseButtons & MouseButtons.Left) == MouseButtons.Left)
                    {
                        DataObject dataObj = new DataObject();
                        dataObj.SetFileDropList(sc);
                        eff = this.DoDragDrop(dataObj, DragDropEffects.Copy | DragDropEffects.Move | DragDropEffects.Link);
                    }

                    if (webView != null && webView.CoreWebView2 != null)
                    {
                        string respJson = js.Serialize(new
                        {
                            type = "nativeDragDone",
                            effect = eff.ToString(),
                            paths = validList.ToArray()
                        });
                        webView.CoreWebView2.PostWebMessageAsJson(respJson);
                    }
                }
                else if (string.Equals(type, "resolveExternalDrop", StringComparison.Ordinal))
                {
                    List<string> droppedPaths = new List<string>();
                    if (e.AdditionalObjects != null)
                    {
                        foreach (object obj in e.AdditionalObjects)
                        {
                            CoreWebView2File wf = obj as CoreWebView2File;
                            if (wf != null && !string.IsNullOrEmpty(wf.Path))
                            {
                                droppedPaths.Add(wf.Path);
                            }
                        }
                    }
                    string targetDir = msg.ContainsKey("targetDir") ? Convert.ToString(msg["targetDir"]) : "";
                    string targetKind = msg.ContainsKey("targetKind") ? Convert.ToString(msg["targetKind"]) : "dir";
                    bool ctrlKey = msg.ContainsKey("ctrlKey") && Convert.ToBoolean(msg["ctrlKey"]);
                    bool shiftKey = msg.ContainsKey("shiftKey") && Convert.ToBoolean(msg["shiftKey"]);

                    if (webView != null && webView.CoreWebView2 != null)
                    {
                        string respJson = js.Serialize(new
                        {
                            type = "externalDropResolved",
                            paths = droppedPaths.ToArray(),
                            targetDir = targetDir,
                            targetKind = targetKind,
                            ctrlKey = ctrlKey,
                            shiftKey = shiftKey
                        });
                        webView.CoreWebView2.PostWebMessageAsJson(respJson);
                    }
                }
                else if (string.Equals(type, "openExternal", StringComparison.Ordinal))
                {
                    string targetPath = msg.ContainsKey("path") ? Convert.ToString(msg["path"]) : "";
                    if (!string.IsNullOrEmpty(targetPath) && (File.Exists(targetPath) || Directory.Exists(targetPath)))
                    {
                        string workDir = Path.GetDirectoryName(targetPath);
                        string ext = (Path.GetExtension(targetPath) ?? "").ToLowerInvariant();
                        ProcessStartInfo psi = new ProcessStartInfo();
                        if (ext == ".bat" || ext == ".cmd")
                        {
                            psi.FileName = "cmd.exe";
                            psi.Arguments = "/c \"\"" + targetPath + "\"\"";
                        }
                        else
                        {
                            psi.FileName = targetPath;
                        }
                        if (!string.IsNullOrEmpty(workDir)) psi.WorkingDirectory = workDir;
                        psi.UseShellExecute = true;
                        psi.WindowStyle = ProcessWindowStyle.Normal;
                        Process.Start(psi);
                    }
                }
            }
            catch (Exception ex)
            {
                HostLogger.Log("WebMessage hatasi: " + ex.Message);
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
}
