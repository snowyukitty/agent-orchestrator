# Long-lived helper for the task host's system-state observer
# (system-state.js). For each line read on stdin it prints one line:
#
#   <session id> <connect state> <session flags>|<AC line status>|<user SID>
#
# or `error` in a field whose query failed. The session queried is this
# process's own, which is the host's: the helper is the host's child.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AoSystemState {
  [DllImport("wtsapi32.dll", SetLastError = true)]
  static extern bool WTSQuerySessionInformationW(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")]
  static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("kernel32.dll")]
  static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
  [DllImport("kernel32.dll")]
  static extern uint GetCurrentProcessId();

  [StructLayout(LayoutKind.Sequential)]
  public struct PowerStatus {
    public byte ACLineStatus;
    public byte BatteryFlag;
    public byte BatteryLifePercent;
    public byte SystemStatusFlag;
    public int BatteryLifeTime;
    public int BatteryFullLifeTime;
  }
  [DllImport("kernel32.dll")]
  static extern bool GetSystemPowerStatus(out PowerStatus status);

  const int WTSSessionInfoEx = 25;

  // WTSINFOEXW: DWORD Level, then the level-1 union, which holds 64-bit
  // fields and therefore starts at offset 8: SessionId, SessionState,
  // SessionFlags.
  public static string Session() {
    uint id;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), out id)) return "error";
    IntPtr buffer;
    int bytes;
    if (!WTSQuerySessionInformationW(IntPtr.Zero, (int)id, WTSSessionInfoEx, out buffer, out bytes)) return "error";
    try {
      if (bytes < 20 || Marshal.ReadInt32(buffer, 0) != 1 || (uint)Marshal.ReadInt32(buffer, 8) != id) return "error";
      return id + " " + Marshal.ReadInt32(buffer, 12) + " " + Marshal.ReadInt32(buffer, 16);
    } finally {
      WTSFreeMemory(buffer);
    }
  }

  public static string Power() {
    PowerStatus status;
    return GetSystemPowerStatus(out status) ? status.ACLineStatus.ToString() : "error";
  }
}
'@
$sid = try { [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { 'error' }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $session = try { [AoSystemState]::Session() } catch { 'error' }
  $power = try { [AoSystemState]::Power() } catch { 'error' }
  [Console]::Out.WriteLine("$session|$power|$sid")
  [Console]::Out.Flush()
}
