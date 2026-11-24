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
}
