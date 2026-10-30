# Long-lived helper that owns the task host's Windows Job Objects
# (process-jobs.js). One request per line, one reply per line, in order:
#
#   <id> adopt <key> <pid> <notBefore FILETIME>  -> <id> ok <created FILETIME> <adopted children>
#   <id> active <key>                            -> <id> ok <live processes in the job>
#   <id> end <key> <wait ms>                     -> <id> ok <live processes left>
#   <id> escapes <key>                           -> <id> ok <children of members still outside the job> <names>
#
# `escapes` and `end` first adopt every live child of a live member that is
# outside the job, and `escapes` reports only those it could not adopt. A
# process can be created outside its parent's job: PowerShell 7 was observed
# starting native commands that way.
#   <id> release <key>                           -> <id> ok
#   <id> ping                                    -> <id> ok
#
# or `<id> error <code>`. `adopt` opens the process (keeping the handle, so its
# pid cannot be reused while the job exists), checks it was created no
# earlier than `notBefore`, puts it in a new job, and also adopts any children
# it started before that. Every process it starts afterwards joins the job by
# itself. `end` terminates every process in the job and waits for the count
# to reach zero.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AoProcessJobs {
  const uint PROCESS_TERMINATE = 0x0001;
  const uint PROCESS_SET_QUOTA = 0x0100;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint SYNCHRONIZE = 0x00100000;
  const uint TH32CS_SNAPPROCESS = 0x2;
  const int JobObjectBasicAccountingInformation = 1;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);

  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint dwSize, cntUsage, th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  class Owned { public IntPtr Job; public List<IntPtr> Handles = new List<IntPtr>(); }
  static readonly Dictionary<string, Owned> jobs = new Dictionary<string, Owned>();

  static long Created(IntPtr process) {
    long creation, exit, kernel, user;
    return GetProcessTimes(process, out creation, out exit, out kernel, out user) ? creation : -1;
  }

  static IntPtr Open(int pid) {
    return OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid);
  }

  static readonly Dictionary<int, string> names = new Dictionary<int, string>();

  static Dictionary<int, List<int>> Children() {
    var children = new Dictionary<int, List<int>>();
    names.Clear();
    IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == new IntPtr(-1)) return children;
    try {
      var entry = new Entry();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
      for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
        int parent = (int)entry.th32ParentProcessID;
        if (!children.ContainsKey(parent)) children[parent] = new List<int>();
        children[parent].Add((int)entry.th32ProcessID);
        names[(int)entry.th32ProcessID] = entry.szExeFile;
      }
    } finally {
      CloseHandle(snapshot);
    }
    return children;
  }

  public static string Adopt(string key, int pid, long notBefore) {
    if (jobs.ContainsKey(key)) return "error duplicate";
    IntPtr root = Open(pid);
    if (root == IntPtr.Zero) return "error open-" + Marshal.GetLastWin32Error();
    long created = Created(root);
    if (created < notBefore) { CloseHandle(root); return "error identity"; }
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { CloseHandle(root); return "error job-" + Marshal.GetLastWin32Error(); }
    if (!AssignProcessToJobObject(job, root)) {
      int code = Marshal.GetLastWin32Error();
      CloseHandle(root);
      CloseHandle(job);
      return "error assign-" + code;
    }
    var owned = new Owned { Job = job };
    owned.Handles.Add(root);
    jobs[key] = owned;
    // Children started before the root joined the job. The root's handle is
    // held, so its pid is its own; a child must also be no older than it.
    int adopted = 0;
    var frontier = new List<KeyValuePair<int, long>> { new KeyValuePair<int, long>(pid, created) };
    var tree = Children();
    while (frontier.Count > 0) {
      var next = new List<KeyValuePair<int, long>>();
      foreach (var parent in frontier) {
        List<int> kids;
        if (!tree.TryGetValue(parent.Key, out kids)) continue;
        foreach (int kid in kids) {
          IntPtr handle = Open(kid);
          if (handle == IntPtr.Zero) continue;
          long kidCreated = Created(handle);
          bool inJob;
          if (kidCreated < parent.Value || !IsProcessInJob(handle, job, out inJob) || inJob) { CloseHandle(handle); continue; }
          if (AssignProcessToJobObject(job, handle)) {
            adopted++;
            owned.Handles.Add(handle);
            next.Add(new KeyValuePair<int, long>(kid, kidCreated));
          } else {
            CloseHandle(handle);
          }
        }
      }
      frontier = next;
    }
    return "ok " + created + " " + adopted;
  }

  static uint Active(IntPtr job) {
    Accounting info;
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) {
      throw new InvalidOperationException("query");
    }
    return info.ActiveProcesses;
  }

  public static string Count(string key) {
    Owned owned;
    if (!jobs.TryGetValue(key, out owned)) return "error unknown";
    return "ok " + Active(owned.Job);
  }

  public static string End(string key, int waitMs) {
    Owned owned;
    if (!jobs.TryGetValue(key, out owned)) return "error unknown";
    for (int pass = 0; pass < 8; pass++) {
      if (AdoptStrays(owned) == 0) break;
    }
    TerminateJobObject(owned.Job, 1);
    var started = DateTime.UtcNow;
    uint active = Active(owned.Job);
    while (active > 0 && (DateTime.UtcNow - started).TotalMilliseconds < waitMs) {
      System.Threading.Thread.Sleep(50);
      active = Active(owned.Job);
    }
    return "ok " + active;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returned);

  static HashSet<int> MemberPids(IntPtr job) {
    // JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR ids.
    int capacity = 4096;
    int size = 8 + capacity * IntPtr.Size;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, 3, buffer, size, IntPtr.Zero)) throw new InvalidOperationException("list");
      int count = Marshal.ReadInt32(buffer, 4);
      var pids = new HashSet<int>();
      for (int i = 0; i < count; i++) pids.Add((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
      return pids;
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  static int AdoptStrays(Owned owned) {
    var members = MemberPids(owned.Job);
    var tree = Children();
    int adopted = 0;
    foreach (int parent in members) {
      List<int> kids;
      if (!tree.TryGetValue(parent, out kids)) continue;
      IntPtr parentHandle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, parent);
      if (parentHandle == IntPtr.Zero) continue;
      long parentCreated = Created(parentHandle);
      CloseHandle(parentHandle);
      foreach (int kid in kids) {
        if (members.Contains(kid)) continue;
        IntPtr handle = Open(kid);
        if (handle == IntPtr.Zero) continue;
        if (Created(handle) >= parentCreated && AssignProcessToJobObject(owned.Job, handle)) {
          adopted++;
          owned.Handles.Add(handle);
        } else {
          CloseHandle(handle);
        }
      }
    }
    return adopted;
  }

  // Children of live members that are not in the job and could not be
  // adopted. Detection only; never ended by pid.
  public static string Escapes(string key) {
    Owned owned;
    if (!jobs.TryGetValue(key, out owned)) return "error unknown";
    // Adopt first, as long as each pass finds someone new.
    for (int pass = 0; pass < 8; pass++) {
      if (AdoptStrays(owned) == 0) break;
    }
    var members = MemberPids(owned.Job);
    var tree = Children();
    int escaped = 0;
    var escapedNames = new List<string>();
    foreach (int parent in members) {
      List<int> kids;
      if (!tree.TryGetValue(parent, out kids)) continue;
      IntPtr parentHandle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, parent);
      if (parentHandle == IntPtr.Zero) continue;
      long parentCreated = Created(parentHandle);
      CloseHandle(parentHandle);
      foreach (int kid in kids) {
        if (members.Contains(kid)) continue;
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, kid);
        long created = handle == IntPtr.Zero ? long.MaxValue : Created(handle);
        if (handle != IntPtr.Zero) CloseHandle(handle);
        if (created >= parentCreated) {
          escaped++;
          string name;
          string parentName; names.TryGetValue(parent, out parentName); if (names.TryGetValue(kid, out name)) escapedNames.Add(System.IO.Path.GetFileNameWithoutExtension(parentName ?? "unknown").Replace(' ', '_') + "-" + System.IO.Path.GetFileNameWithoutExtension(name).Replace(' ', '_'));
        }
      }
    }
    return "ok " + escaped + (escapedNames.Count > 0 ? " " + string.Join(",", escapedNames) : "");
  }

  public static string Release(string key) {
    Owned owned;
    if (!jobs.TryGetValue(key, out owned)) return "ok";
    foreach (IntPtr handle in owned.Handles) CloseHandle(handle);
    CloseHandle(owned.Job);
    jobs.Remove(key);
    return "ok";
  }
}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Trim().Split(' ')
  $id = $parts[0]
  $reply = try {
    switch ($parts[1]) {
      'adopt' { [AoProcessJobs]::Adopt($parts[2], [int]$parts[3], [long]$parts[4]) }
      'active' { [AoProcessJobs]::Count($parts[2]) }
      'end' { [AoProcessJobs]::End($parts[2], [int]$parts[3]) }
      'escapes' { [AoProcessJobs]::Escapes($parts[2]) }
      'release' { [AoProcessJobs]::Release($parts[2]) }
      'ping' { 'ok' }
      default { 'error unknown-command' }
    }
  } catch { 'error exception' }
  [Console]::Out.WriteLine("$id $reply")
  [Console]::Out.Flush()
}
