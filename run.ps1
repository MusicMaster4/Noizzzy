$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workerRoot = Join-Path $projectRoot "worker"
$webRoot = Join-Path $projectRoot "web"
$runtimeRoot = Join-Path $projectRoot ".runtime"
$workerPython = Join-Path $workerRoot ".venv\Scripts\python.exe"
$enhancerPython = Join-Path $workerRoot ".clearvoice-venv\Scripts\python.exe"
$backendPort = 35592
$frontendPort = 27295
$backendUrl = "http://localhost:$backendPort"
$frontendUrl = "http://localhost:$frontendPort"

if (-not (Test-Path -LiteralPath $workerPython)) { throw "Worker não instalado. Execute .\install.ps1 primeiro." }
if (-not (Test-Path -LiteralPath $enhancerPython)) { throw "ClearerVoice não instalado. Execute .\install.ps1 primeiro." }
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$env:VOICE_ENHANCER_PYTHON = $enhancerPython.Replace("\", "/")
$env:VOICE_CORS_ORIGINS = $frontendUrl
$env:NEXT_PUBLIC_API_URL = $backendUrl

function Stop-ProcessTree {
  param([Parameter(Mandatory = $true)][int]$RootProcessId)

  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -RootProcessId $child.ProcessId
  }

  Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

if (-not ("VoxPolish.ProcessJob" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace VoxPolish {
  public static class ProcessJob {
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation {
      public BasicLimitInformation BasicLimitInformation;
      public IoCounters IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
      IntPtr job,
      int informationClass,
      IntPtr information,
      uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateKillOnClose() {
      IntPtr job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

      ExtendedLimitInformation limits = new ExtendedLimitInformation();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int length = Marshal.SizeOf(typeof(ExtendedLimitInformation));
      IntPtr pointer = Marshal.AllocHGlobal(length);
      try {
        Marshal.StructureToPtr(limits, pointer, false);
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)length)) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
      } catch {
        CloseHandle(job);
        throw;
      } finally {
        Marshal.FreeHGlobal(pointer);
      }
      return job;
    }

    public static void Assign(IntPtr job, IntPtr process) {
      if (!AssignProcessToJobObject(job, process)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
    }

    public static void Close(IntPtr job) {
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
"@
}

$apiOut = Join-Path $runtimeRoot "worker.log"
$apiErr = Join-Path $runtimeRoot "worker-error.log"
$webOut = Join-Path $runtimeRoot "web.log"
$webErr = Join-Path $runtimeRoot "web-error.log"
$api = $null
$web = $null
$processJob = [VoxPolish.ProcessJob]::CreateKillOnClose()
try {
  $api = Start-Process -FilePath $workerPython -ArgumentList @("-m", "uvicorn", "voice_worker.main:app", "--host", "127.0.0.1", "--port", $backendPort) -WorkingDirectory $workerRoot -WindowStyle Hidden -RedirectStandardOutput $apiOut -RedirectStandardError $apiErr -PassThru
  [VoxPolish.ProcessJob]::Assign($processJob, $api.Handle)
  $web = Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev") -WorkingDirectory $webRoot -WindowStyle Hidden -RedirectStandardOutput $webOut -RedirectStandardError $webErr -PassThru
  [VoxPolish.ProcessJob]::Assign($processJob, $web.Handle)

  Write-Host "Vox Polish iniciado em $frontendUrl" -ForegroundColor Green
  Write-Host "Pressione Ctrl+C para encerrar. Logs: $runtimeRoot"
  while (-not $api.HasExited -and -not $web.HasExited) {
    Start-Sleep -Seconds 1
    $api.Refresh(); $web.Refresh()
  }
  if ($api.HasExited) { throw "O worker encerrou. Consulte $apiErr" }
  if ($web.HasExited) { throw "A interface encerrou. Consulte $webErr" }
}
finally {
  foreach ($process in @($web, $api)) {
    if ($process -and -not $process.HasExited) { Stop-ProcessTree -RootProcessId $process.Id }
  }
  [VoxPolish.ProcessJob]::Close($processJob)
  Write-Host "Vox Polish encerrado."
}
