param([Parameter(Mandatory=$true)][string]$Installer, [Parameter(Mandatory=$true)][string]$InstallRoot, [Parameter(Mandatory=$true)][string]$DataRoot)
$ErrorActionPreference = 'Stop'
# Remove the audit privilege from this test process only, even on administrator
# CI runners. Set-Acl must not silently pass merely because the runner has it.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class InstallerPrivilegeFixture {
    [StructLayout(LayoutKind.Sequential)] private struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] private struct TokenPrivilege { public uint Count; public Luid Id; public uint Attributes; }
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool LookupPrivilegeValue(string system, string name, out Luid id);
    [DllImport("advapi32.dll", SetLastError=true)] private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilege state, uint length, IntPtr previous, IntPtr returnedLength);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    public static void RemoveAuditPrivilege() {
        IntPtr token;
        if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 0x28, out token)) throw new Win32Exception();
        try {
            var state = new TokenPrivilege(); state.Count = 1; state.Attributes = 4; // SE_PRIVILEGE_REMOVED
            if (!LookupPrivilegeValue(null, "SeSecurityPrivilege", out state.Id)) throw new Win32Exception();
            if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            int error = Marshal.GetLastWin32Error();
            if (error != 0 && error != 1300) throw new Win32Exception(error); // Already absent is expected for standard users.
        } finally { CloseHandle(token); }
    }
}
'@
[InstallerPrivilegeFixture]::RemoveAuditPrivilege()
$privileges = & (Join-Path $env:SystemRoot 'System32\whoami.exe') /priv
if ($LASTEXITCODE -ne 0 -or ($privileges -join "`n") -match '\bSeSecurityPrivilege\b') { throw 'The installer regression must run without SeSecurityPrivilege.' }
$sections = [Security.AccessControl.AccessControlSections]'Access,Owner,Group'
$previousOwner = if (Test-Path -LiteralPath $DataRoot) { [IO.Directory]::GetAccessControl($DataRoot, $sections).GetOwner([Security.Principal.SecurityIdentifier]).Value } else { $null }
& $Installer -InstallRoot $InstallRoot -DataRoot $DataRoot -NoRegister
if (-not $?) { throw 'The isolated installer failed without the audit privilege.' }
$acl = [IO.Directory]::GetAccessControl($DataRoot, $sections)
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$expected = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 2) { throw 'Authentication data permissions are not protected and limited to two accounts.' }
foreach ($sid in $expected) {
    $rule = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid })
    if ($rule.Count -ne 1 -or $rule[0].IsInherited -or $rule[0].AccessControlType -ne 'Allow' -or $rule[0].FileSystemRights -ne 'FullControl' -or $rule[0].InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $rule[0].PropagationFlags -ne 'None') { throw 'Authentication data permissions changed unexpectedly.' }
}
if ($previousOwner -and $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $previousOwner) { throw 'Reinstall changed the authentication data directory owner.' }
