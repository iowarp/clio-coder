/** Windows shell identity shared by the Start Menu entry and the hosted Chromium window. */
export const windowsIdentitySource = `using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class ClioIdentity {
    [StructLayout(LayoutKind.Sequential, Pack=4)] public struct Key {
        public Guid format;
        public uint id;
        public Key(uint n) {
            format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
            id=n;
        }
    }
    [StructLayout(LayoutKind.Explicit, Size=24)] public struct Variant {
        [FieldOffset(0)] public ushort type;
        [FieldOffset(8)] public IntPtr value;
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface Store {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint i, out Key key);
        [PreserveSig] int GetValue(ref Key key, out Variant value);
        [PreserveSig] int SetValue(ref Key key, ref Variant value);
        [PreserveSig] int Commit();
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)] static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr context, uint flags, ref Guid iid, out Store store);
    [DllImport("shell32.dll", PreserveSig=false)] static extern void SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, out Store store);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref Variant value);
    delegate bool Visit(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(Visit visit, IntPtr state);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command,out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static bool UsesProfile(string command,string profile) {
        if(String.IsNullOrEmpty(command)) return false;
        int count;
        var args=CommandLineToArgvW(command,out count);
        if(args==IntPtr.Zero) return false;
        try {
            for(int i=0;i<count;i++) if(String.Equals(Marshal.PtrToStringUni(Marshal.ReadIntPtr(args,i*IntPtr.Size)),"--user-data-dir="+profile,StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }
        finally {
            LocalFree(args);
        }
    }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr window,bool altTab);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
    public static void Focus(long handle) {
        var window=new IntPtr(handle);
        ShowWindow(window,9);
        if(GetForegroundWindow()!=window) {
            SwitchToThisWindow(window,true);
            System.Threading.Thread.Sleep(300);
        }
    }
    public static void Close(long handle) {
        PostMessage(new IntPtr(handle),0x0010,IntPtr.Zero,IntPtr.Zero);
    }
    public static IntPtr Window(int pid) {
        IntPtr result=IntPtr.Zero;
        EnumWindows((window,state)=> {
            uint owner; GetWindowThreadProcessId(window,out owner); if(owner==(uint)pid && IsWindowVisible(window)) {
                var name=new StringBuilder(128); GetClassName(window,name,128); if(name.ToString()=="Chrome_WidgetWin_1") {
                    result=window;return false;
                }
            }
            return true;
        }
        ,IntPtr.Zero);
        return result;
    }
    public static long[] Windows(int pid) {
        var result=new List<long>();
        EnumWindows((window,state)=> {
            uint owner; GetWindowThreadProcessId(window,out owner); if(owner==(uint)pid && IsWindowVisible(window)) {
                var name=new StringBuilder(128); GetClassName(window,name,128); if(name.ToString()=="Chrome_WidgetWin_1") result.Add(window.ToInt64());
            }
            return true;
        }
        ,IntPtr.Zero);
        return result.ToArray();
    }
    static void Set(Store store,uint id,string text) {
        var key=new Key(id);
        var value=new Variant {
            type=31,value=Marshal.StringToCoTaskMemUni(text)
        }
        ;
        try {
            int result=store.SetValue(ref key,ref value);
            if(result<0) throw new Exception("Windows shell property "+id+" failed ("+text.Length+" characters): "+Marshal.GetExceptionForHR(result).Message);
        }
        finally {
            PropVariantClear(ref value);
        }
    }
    static string Get(Store store,uint id) {
        var key=new Key(id);
        Variant value;
        Marshal.ThrowExceptionForHR(store.GetValue(ref key,out value));
        try {
            return value.type==31 ? Marshal.PtrToStringUni(value.value) : "";
        }
        finally {
            PropVariantClear(ref value);
        }
    }
    public static string WindowId(long window) {
        var iid=typeof(Store).GUID;
        Store store;
        SHGetPropertyStoreForWindow(new IntPtr(window),ref iid,out store);
        try {
            return Get(store,5);
        }
        finally {
            Marshal.ReleaseComObject(store);
        }
    }
    public static void SetWindow(long window,string id,string command,string icon) {
        var iid=typeof(Store).GUID;
        Store store;
        SHGetPropertyStoreForWindow(new IntPtr(window),ref iid,out store);
        try {
            Set(store,2,command);
            Set(store,3,icon);
            Set(store,4,"Clio Coder");
            Set(store,5,id);
        }
        finally {
            Marshal.ReleaseComObject(store);
        }
    }
    public static void SetShortcut(string file,string id) {
        var iid=typeof(Store).GUID;
        Store store;
        SHGetPropertyStoreFromParsingName(file,IntPtr.Zero,2,ref iid,out store);
        try {
            Set(store,5,id);
            Marshal.ThrowExceptionForHR(store.Commit());
        }
        finally {
            Marshal.ReleaseComObject(store);
        }
    }
}
`;

/** Values are forwarded by runWindowsPowerShell; neither URLs nor paths become PowerShell code. */
export const windowsAppScript = String.raw`
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'identity.cs')
$id=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'app-id')).Trim()
$mutex=New-Object System.Threading.Mutex($false,('Local\ClioCoder.'+$id))
$acquired=$false
try {
 try { $acquired=$mutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $acquired=$true }
 if(-not $acquired) { throw 'Another Clio Coder launch is still in progress. Retry after it finishes.' }
$profile=Join-Path $PSScriptRoot 'browser'
$browser=@(
 'C:\Program Files\Google\Chrome\Application\chrome.exe',
 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
 'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $browser) { throw 'Clio Coder needs Chrome or Edge to open its desktop window.' }
$url=[Uri]$env:CLIO_WIN_URL
if ($url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1') { throw 'Clio Coder refused a non-local desktop address.' }
# Chromium derives its installed app id by hashing the stable manifest identity twice.
$manifestId=$url.GetLeftPart([UriPartial]::Authority)+'/'
$sha=[Security.Cryptography.SHA256]::Create()
try { $digest=$sha.ComputeHash($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($manifestId))) } finally { $sha.Dispose() }
$pwaId=-join ($digest[0..15] | ForEach-Object { [char](97+($_ -shr 4)); [char](97+($_ -band 15)) })
$pwaShortcut=Join-Path $profile ('Default\Web Applications\_crx_'+$pwaId+'\Clio Coder.lnk')
$installed=Test-Path -LiteralPath $pwaShortcut
$mode=if($installed) { 'pwa' } else { 'app' }
$name=[IO.Path]::GetFileName($browser)
function AppWindows {
 $found=@()
 foreach($p in (Get-CimInstance Win32_Process -Filter ("name='" + $name + "'") | Where-Object { [ClioIdentity]::UsesProfile($_.CommandLine,$profile) -and -not $_.CommandLine.Contains('--type=') })) { $found += [ClioIdentity]::Windows($p.ProcessId) }
 return $found
}
$existing=@(AppWindows)
$link=Join-Path $PSScriptRoot 'last-link'
$modeFile=Join-Path $PSScriptRoot 'last-window-mode'
$sameMode=(Test-Path -LiteralPath $modeFile) -and [IO.File]::ReadAllText($modeFile) -eq $mode
if($sameMode -and $existing.Count -gt 0 -and (Test-Path -LiteralPath $link) -and [IO.File]::ReadAllText($link) -eq $url.AbsoluteUri) {
 [ClioIdentity]::Focus($existing[0]); return
}
if($existing.Count -gt 0) {
 # A changed port or credential cannot reconnect the old window. Close only this owned profile's windows.
 foreach($w in $existing) { [ClioIdentity]::Close($w) }
 for($i=0; $i -lt 30 -and @(AppWindows).Count -gt 0; $i++) { Start-Sleep -Milliseconds 200 }
 if(@(AppWindows).Count -gt 0) { throw 'Close the previous Clio Coder window, then reopen the app to reconnect.' }
}
$arguments='"--user-data-dir=' + $profile + '" --no-first-run --no-default-browser-check --disable-background-mode'
if($installed) {
 $arguments += ' --profile-directory=Default --app-id='+$pwaId+' "--app-launch-url-for-shortcuts-menu-item='+$url.AbsoluteUri+'"'
} else {
 $arguments += ' "--app='+$url.AbsoluteUri+'"'
}
Start-Process -FilePath $browser -ArgumentList $arguments
$window=[IntPtr]::Zero
$name=[IO.Path]::GetFileName($browser)
for($i=0; $i -lt 40 -and $window -eq [IntPtr]::Zero; $i++) {
 Start-Sleep -Milliseconds 200
 foreach($p in (Get-CimInstance Win32_Process -Filter ("name='" + $name + "'") | Where-Object { $_.CommandLine -and [ClioIdentity]::UsesProfile($_.CommandLine,$profile) -and -not $_.CommandLine.Contains('--type=') })) {
  $window=[ClioIdentity]::Window($p.ProcessId)
  if($window -ne [IntPtr]::Zero) { break }
 }
}
if($window -eq [IntPtr]::Zero) { throw 'The Clio Coder desktop window did not appear.' }
$relaunch='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoP -W Hidden -EP Bypass -File "' + (Join-Path $PSScriptRoot 'open.ps1') + '"'
$id=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'app-id')).Trim()
foreach($p in (Get-CimInstance Win32_Process -Filter ("name='" + $name + "'") | Where-Object { [ClioIdentity]::UsesProfile($_.CommandLine,$profile) -and -not $_.CommandLine.Contains('--type=') })) { foreach($w in [ClioIdentity]::Windows($p.ProcessId)) { [ClioIdentity]::SetWindow($w,$id,$relaunch,((Join-Path $PSScriptRoot 'clio-coder.ico') + ',0')) } }
[IO.File]::WriteAllText($link,$url.AbsoluteUri)
[IO.File]::WriteAllText($modeFile,$mode)
} finally { if($acquired) { $mutex.ReleaseMutex() }; $mutex.Dispose() }

`;
