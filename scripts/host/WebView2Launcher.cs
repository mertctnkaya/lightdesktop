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

        public static bool RunWindow(string url, string runtimeDir, Action<Form> onCreated, out string fallbackReason, Task<string> urlTask = null)
        {
            string reasonLocal = "";
            bool needFallback = false;
            using (WebView2WindowForm form = new WebView2WindowForm(url, HostLogger.CacheRoot, delegate(string r)
            {
                reasonLocal = r;
                needFallback = true;
            }, urlTask))
            {
                if (onCreated != null) onCreated(form);
                Application.Run(form);
            }
            fallbackReason = reasonLocal;
            return !needFallback;
        }

        public static Form CreateBackgroundWindow(string url, string runtimeDir, Action<string> onFallback)
        {
            string loader = Path.Combine(runtimeDir, "WebView2Loader.dll");
            if (File.Exists(loader)) NativeWin32.LoadLibrary(loader);
            WebView2WindowForm form = new WebView2WindowForm(url, HostLogger.CacheRoot, onFallback);
            form.EnablePipeServer = false;
            return form;
        }
    }
}
