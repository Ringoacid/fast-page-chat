using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed class SetupForm : Form {
    private readonly Label status = new Label();
    private readonly Button install = new Button();
    private readonly Button folder = new Button();
    private bool completed;
    internal SetupForm() {
        Text = "Fast Page Chat セットアップ"; ClientSize = new Size(510, 315);
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Yu Gothic UI", 10); BackColor = Color.White;
        var title = new Label { Text = "ページを開いたまま、AIに質問。", Location = new Point(25, 24), Size = new Size(460, 36), Font = new Font("Yu Gothic UI", 17, FontStyle.Bold) };
        var body = new Label { Text = "このPCに接続用アプリをインストールします。\nNode.jsの準備や接続キーの入力は不要です。\n\nログインとAPI設定は、インストール後に\nChrome拡張機能から行います。", Location = new Point(27, 72), Size = new Size(460, 125) };
        status.Location = new Point(27, 205); status.Size = new Size(455, 45);
        install.Text = "インストール"; install.Location = new Point(340, 263); install.Size = new Size(145, 32);
        folder.Text = "拡張機能フォルダーを開く"; folder.Location = new Point(25, 263); folder.Size = new Size(240, 32); folder.Visible = false;
        install.Click += async (sender, args) => await Install();
        folder.Click += (sender, args) => Process.Start("explorer.exe", "\"" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FastPageChat", "app", "extension") + "\"");
        Controls.AddRange(new Control[] { title, body, status, install, folder });
    }
    private async Task Install() {
        if (completed) { Close(); return; }
        install.Enabled = false; status.Text = "インストールしています…";
        string temp = Path.Combine(Path.GetTempPath(), "FastPageChat-install-" + Guid.NewGuid().ToString("N"));
        try {
            await Task.Run(() => {
                Directory.CreateDirectory(temp);
                using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                using (var zip = new ZipArchive(input, ZipArchiveMode.Read)) {
                    // The payload is compiled into this installer. Still reject paths outside our directory.
                    foreach (var entry in zip.Entries) {
                        string path = Path.GetFullPath(Path.Combine(temp, entry.FullName));
                        if (!path.StartsWith(temp + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Invalid package path.");
                        if (String.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(path); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(path)); entry.ExtractToFile(path);
                    }
                }
                var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"));
                start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + Path.Combine(temp, "install.ps1") + "\"";
                start.UseShellExecute = false; start.CreateNoWindow = true;
                // Avoid Framework's environment dictionary, which rejects inherited PATH/Path duplicates.
                // This changes only this installer process and its children, not user/system settings.
                Environment.SetEnvironmentVariable("PSModulePath", null);
                start.RedirectStandardOutput = true; start.RedirectStandardError = true;
                using (var child = Process.Start(start)) {
                    string error = child.StandardError.ReadToEnd(); child.StandardOutput.ReadToEnd(); child.WaitForExit();
                    if (child.ExitCode != 0) throw new Exception(String.IsNullOrWhiteSpace(error) ? "Installation failed." : error);
                }
            });
            status.Text = "インストール完了。拡張機能をChromeへ読み込み、\n「補助アプリに接続する」を押してください。";
            completed = true; install.Text = "閉じる"; install.Enabled = true;
            folder.Visible = true;
        } catch (Exception error) {
            status.Text = "インストールできませんでした。";
            MessageBox.Show(error.Message, "Fast Page Chat", MessageBoxButtons.OK, MessageBoxIcon.Error);
            install.Enabled = true;
        } finally {
            if (Path.GetFullPath(temp).StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)) {
                try { if (Directory.Exists(temp)) Directory.Delete(temp, true); } catch { }
            }
        }
    }
    [STAThread] private static void Main() { Application.EnableVisualStyles(); Application.Run(new SetupForm()); }
}
