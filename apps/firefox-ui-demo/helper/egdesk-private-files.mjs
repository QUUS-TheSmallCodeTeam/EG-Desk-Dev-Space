import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Read-only permission checks shared by production storage and QA tooling.
// This module never changes an existing path or its permissions.
// chmod/uid do not describe Windows file ownership. Keep the same write
// boundary using the actual owner SID and DACL, including inherited rules.
export function isSafeWindowsAcl(acl, mask = 0o022) {
  if (!/^S-\d-(?:\d+-)*\d+$/.test(acl?.self || '') || acl.owner !== acl.self
      || !Array.isArray(acl.rules) || !acl.rules.length) return false;
  const allowed = new Set([acl.self, 'S-1-5-18', 'S-1-5-32-544']);
  const forbidden = mask & 0o044 ? 0x001f01ff : 0x000d0156;
  return acl.rules.every(rule => typeof rule.sid === 'string'
    && Number.isSafeInteger(rule.rights) && typeof rule.allow === 'boolean'
    && (!rule.allow || allowed.has(rule.sid) || (rule.rights & forbidden) === 0));
}

function windowsAcl(target) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Paths cross the process boundary as data, never interpolated shell code.
  const script = `$ErrorActionPreference='Stop';
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);
$target=$env:EGDESK_QA_ACL_TARGET;
$self=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$item=Get-Item -LiteralPath $target -Force;
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Reparse target refused'};
$acl=Get-Acl -LiteralPath $target;
[pscustomobject]@{self=$self.Value;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{[pscustomobject]@{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights;allow=($_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow)}})}|ConvertTo-Json -Depth 4 -Compress`;
  return JSON.parse(execFileSync(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
      // A PowerShell 7 parent may otherwise make Windows PowerShell load
      // incompatible versions of its built-in security module.
      env: { ...process.env, PSModulePath: path.join(path.dirname(powershell), 'Modules'),
        EGDESK_QA_ACL_TARGET: target },
    }));
}

export function isOwnedAndPrivate(target, info = fs.lstatSync(target), mask = 0o022) {
  if (info.isSymbolicLink() || fs.realpathSync.native(target) !== target) return false;
  if (process.platform !== 'win32') return info.uid === process.getuid() && (info.mode & mask) === 0;
  return isSafeWindowsAcl(windowsAcl(target), mask);
}
