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
}
