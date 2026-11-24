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
    internal static class HostLogger
    {
        private static readonly object LockObj = new object();
        private static readonly List<string> Lines = new List<string>();
        public static string CacheRoot = ResolveCacheRoot();
        public static string HostLogFile = Path.Combine(CacheRoot, "host-logs.txt");
        public static string NodeLogFile = Path.Combine(CacheRoot, "logs.txt");
        public static string StartupProfileFile = Path.Combine(CacheRoot, "startup-profile.txt");
        private static readonly Stopwatch StartupSw = Stopwatch.StartNew();
        public static long StartupEpochMs = GetUnixEpochMs();
        private static long lastProfileMs = 0;

        public static long GetUnixEpochMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        public static void ProfileStart(string info)
        {
            lock (LockObj)
            {
                try
                {
                    if (File.Exists(StartupProfileFile) && new FileInfo(StartupProfileFile).Length > 256 * 1024)
                    {
                        File.Delete(StartupProfileFile);
                    }
                    long bootPreMainMs = StartupSw.ElapsedMilliseconds;
                    StartupEpochMs = GetUnixEpochMs();
                    StartupSw.Restart();
                    lastProfileMs = 0;
                    string header = Environment.NewLine
                        + string.Format("================ STARTUP PROFILE ({0:yyyy-MM-dd HH:mm:ss.fff}) ================", DateTime.Now) + Environment.NewLine
                        + "  " + info + " | CLR->Main=" + bootPreMainMs + " ms" + Environment.NewLine;
                    File.AppendAllText(StartupProfileFile, header, Encoding.UTF8);
                }
                catch { }
            }
        }

        public static void ProfileMark(string stage)
        {
            lock (LockObj)
            {
                try
                {
                    long now = StartupSw.ElapsedMilliseconds;
                    long delta = now - lastProfileMs;
                    lastProfileMs = now;
                    string line = string.Format("  +{0,5} ms  (d +{1,4} ms)  [HOST] {2}", now, delta, stage);
                    File.AppendAllText(StartupProfileFile, line + Environment.NewLine, Encoding.UTF8);
                }
                catch { }
            }
        }

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
}
