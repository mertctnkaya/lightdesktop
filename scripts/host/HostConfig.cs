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
        public const string ReadyEventName = "Local\\LightDesktop_PipeReady_v1";
        public const int DefaultPort = 3847;
    }
}
