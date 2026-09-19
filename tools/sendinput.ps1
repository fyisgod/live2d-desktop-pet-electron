# 桌面级输入注入（Win32 SetCursorPos + mouse_event），用于自动化验证点击穿透与窗口拖拽。
# 用法示例：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/sendinput.ps1 -Action move -X 100 -Y 200
#   powershell ... -Action click
#   powershell ... -Action down
#   powershell ... -Action up
#   powershell ... -Action drag -X 100 -Y 200 -X2 220 -Y2 260 -Steps 8 -StepMs 25
param(
  [Parameter(Mandatory = $true)][ValidateSet('move', 'click', 'down', 'up', 'drag', 'pos')][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$X2 = 0,
  [int]$Y2 = 0,
  [int]$Steps = 8,
  [int]$StepMs = 25
)

Add-Type -Namespace L2DPet -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll", SetLastError = true)]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
[DllImport("user32.dll")]
public static extern bool GetCursorPos(out POINT lpPoint);
[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
public const uint LEFTDOWN = 0x0002;
public const uint LEFTUP = 0x0004;
'@ -ErrorAction Stop

function Move-To([int]$tx, [int]$ty) {
  [void][L2DPet.Native]::SetCursorPos($tx, $ty)
  Start-Sleep -Milliseconds 12
}
function Click-At() {
  [L2DPet.Native]::mouse_event([L2DPet.Native]::LEFTDOWN, 0, 0, 0, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [L2DPet.Native]::mouse_event([L2DPet.Native]::LEFTUP, 0, 0, 0, [System.UIntPtr]::Zero)
}

$before = New-Object L2DPet.Native+POINT
[void][L2DPet.Native]::GetCursorPos([ref]$before)

switch ($Action) {
  'pos' {
    Write-Output ('{"x":' + $before.X + ',"y":' + $before.Y + '}')
    exit 0
  }
  'move' {
    Move-To $X $Y
  }
  'click' {
    Move-To $X $Y
    # 给目标窗口留出处理 mousemove（穿透状态切换要经 renderer→IPC→主进程）的时间
    Start-Sleep -Milliseconds 300
    Click-At
  }
  'down' {
    Move-To $X $Y
    [L2DPet.Native]::mouse_event([L2DPet.Native]::LEFTDOWN, 0, 0, 0, [System.UIntPtr]::Zero)
  }
  'up' {
    [L2DPet.Native]::mouse_event([L2DPet.Native]::LEFTUP, 0, 0, 0, [System.UIntPtr]::Zero)
  }
  'drag' {
    Move-To $X $Y
    Start-Sleep -Milliseconds 150
    [L2DPet.Native]::mouse_event([L2DPet.Native]::LEFTDOWN, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    for ($i = 1; $i -le $Steps; $i++) {
      $nx = [int]($X + ($X2 - $X) * $i / $Steps)
      $ny = [int]($Y + ($Y2 - $Y) * $i / $Steps)
      [void][L2DPet.Native]::SetCursorPos($nx, $ny)
      Start-Sleep -Milliseconds $StepMs
    }
    Start-Sleep -Milliseconds 120
    [L2DPet.Native]::mouse_event([L2DPet.Native]::LEFTUP, 0, 0, 0, [System.UIntPtr]::Zero)
  }
}

Write-Output ('{"ok":true,"action":"' + $Action + '","fromX":' + $before.X + ',"fromY":' + $before.Y + '}')
