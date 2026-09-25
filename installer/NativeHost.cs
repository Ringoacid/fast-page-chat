using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.Text;

// Small stdio launcher. Chrome never needs to discover Node or a command shell.
internal static class NativeHost {
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfo startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public uint cb; public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr hProcess, hThread; public uint processId, threadId; }
    private static int StartBridge(string root, string dataDirectory) {
        // The long-lived bridge must not inherit ANY browser/native-host pipe,
        // including handles other than the three Windows standard handles.
        // Only this fixed bundled entrypoint can be launched by the private mode.
        Environment.SetEnvironmentVariable("FPC_DATA_DIR", dataDirectory);
        Environment.SetEnvironmentVariable("CODEX_BIN", Path.Combine(root, "runtime", "codex.exe"));
        string node = Path.Combine(root, "runtime", "node.exe");
        string server = Path.Combine(root, "server", "main.mjs");
        var startup = new StartupInfo(); startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
        ProcessInformation created;
        // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP; no STARTF_USESTDHANDLES.
        if (!CreateProcessW(node, new StringBuilder("\"" + node + "\" \"" + server + "\""), IntPtr.Zero, IntPtr.Zero, false,
            0x08000200, IntPtr.Zero, root, ref startup, out created)) return 1;
        CloseHandle(created.hThread); CloseHandle(created.hProcess);
        return 0;
    }
    private static byte[] ReadExactly(Stream input, int count) {
        byte[] bytes = new byte[count]; int offset = 0;
        while (offset < count) { int read = input.Read(bytes, offset, count - offset); if (read == 0) throw new EndOfStreamException(); offset += read; }
        return bytes;
    }
    private static int Main(string[] args) {
        bool startBridge = args.Length == 1 && args[0] == "--start-bridge";
        if (!startBridge && (args.Length < 1 || !System.Text.RegularExpressions.Regex.IsMatch(args[0], @"^chrome-extension://[a-p]{32}/$"))) return 1;
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string dataFile = Path.Combine(root, "runtime-data-path.txt");
        string dataDirectory = File.Exists(dataFile) ? Path.GetFullPath(File.ReadAllText(dataFile).Trim()) : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FastPageChat", "data");
        if (startBridge) { try { return StartBridge(root, dataDirectory); } catch { return 1; } }
        var start = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"));
        start.Arguments = "\"" + Path.Combine(root, "server", "native-host.mjs") + "\" \"" + args[0] + "\"";
        start.WorkingDirectory = root;
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        start.EnvironmentVariables["FPC_DATA_DIR"] = dataDirectory;
        start.EnvironmentVariables["CODEX_BIN"] = Path.Combine(root, "runtime", "codex.exe");
        try {
            // Process.Start on .NET Framework can inherit unrelated standard
            // handles. Never let the detached bridge keep Chrome's pipe alive.
            foreach (int id in new int[] { -10, -11, -12 }) {
                IntPtr handle = GetStdHandle(id);
                if (handle != IntPtr.Zero && handle != new IntPtr(-1) && !SetHandleInformation(handle, 1, 0)) return 1;
            }
            using (var child = Process.Start(start)) {
                child.ErrorDataReceived += (sender, data) => { }; child.BeginErrorReadLine();
                Task exchange = Task.Run(() => {
                    // Chrome leaves stdin open while waiting for its response.
                    // Copy exactly one frame and flush it immediately; copying
                    // until EOF can leave the request buffered indefinitely.
                    Stream source = Console.OpenStandardInput();
                    byte[] requestHeader = ReadExactly(source, 4);
                    uint requestLength = BitConverter.ToUInt32(requestHeader, 0);
                    if (requestLength == 0 || requestLength > 4096) throw new InvalidDataException();
                    byte[] requestBody = ReadExactly(source, (int)requestLength);
                    Stream input = child.StandardInput.BaseStream;
                    input.Write(requestHeader, 0, requestHeader.Length);
                    input.Write(requestBody, 0, requestBody.Length); input.Flush(); child.StandardInput.Close();
                    byte[] header = ReadExactly(child.StandardOutput.BaseStream, 4);
                    uint length = BitConverter.ToUInt32(header, 0);
                    if (length == 0 || length > 1000000) throw new InvalidDataException();
                    byte[] body = ReadExactly(child.StandardOutput.BaseStream, (int)length);
                    Stream target = Console.OpenStandardOutput();
                    target.Write(header, 0, header.Length); target.Write(body, 0, body.Length); target.Flush();
                });
                try { if (!exchange.Wait(60000)) { child.Kill(); return 1; } }
                catch { try { child.Kill(); } catch { } return 1; }
                if (!child.WaitForExit(5000)) { child.Kill(); return 1; }
                return child.ExitCode;
            }
        } catch { return 1; }
    }
}
