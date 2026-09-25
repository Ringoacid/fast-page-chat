using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// Node normalizes Windows environment keys. Use the real Win32 environment block
// to reproduce PATH/Path inherited from Windows tools without changing settings.
internal static class DuplicateEnvironment {
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfo startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public uint cb; public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr hProcess, hThread; public uint processId, threadId; }

    private static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--framework-probe") {
            try { new ProcessStartInfo().EnvironmentVariables.Remove("PSModulePath"); }
            catch (ArgumentException) { return 0; }
            return 2; // Fail the test if its environment no longer reproduces the bug.
        }
        bool probe = args.Length == 1 && args[0] == "--probe";
        if (!probe && args.Length != 2) return 3;
        string executable = probe ? typeof(DuplicateEnvironment).Assembly.Location : args[0];
        string argument = probe ? "--framework-probe" : args[1];
        // The fixture only accepts a fixed executable path and native origin.
        if (executable.Contains("\"") || argument.Contains("\"") || argument.EndsWith("\\")) return 3;
        var entries = new List<string>();
        foreach (DictionaryEntry item in Environment.GetEnvironmentVariables()) {
            if (!String.Equals((string)item.Key, "PATH", StringComparison.OrdinalIgnoreCase)) entries.Add(item.Key + "=" + item.Value);
        }
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        entries.Add("PATH=" + path); entries.Add("Path=" + path);
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        IntPtr environment = Marshal.StringToHGlobalUni(String.Join("\0", entries.ToArray()) + "\0\0");
        var startup = new StartupInfo(); startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
        startup.dwFlags = 0x100; // STARTF_USESTDHANDLES: preserve native messaging pipes.
        startup.hStdInput = GetStdHandle(-10); startup.hStdOutput = GetStdHandle(-11); startup.hStdError = GetStdHandle(-12);
        foreach (IntPtr handle in new IntPtr[] { startup.hStdInput, startup.hStdOutput, startup.hStdError }) {
            if (!SetHandleInformation(handle, 1, 1)) { Marshal.FreeHGlobal(environment); return 4; }
        }
        ProcessInformation created;
        bool started = CreateProcessW(executable, new StringBuilder("\"" + executable + "\" \"" + argument + "\""), IntPtr.Zero, IntPtr.Zero,
            true, 0x08000400, environment, Environment.CurrentDirectory, ref startup, out created); // CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
        Marshal.FreeHGlobal(environment);
        if (!started) return 5;
        try {
            if (WaitForSingleObject(created.hProcess, 15000) != 0) { TerminateProcess(created.hProcess, 6); return 6; }
            uint exitCode;
            return GetExitCodeProcess(created.hProcess, out exitCode) ? (int)exitCode : 7;
        } finally { CloseHandle(created.hThread); CloseHandle(created.hProcess); }
    }
}
