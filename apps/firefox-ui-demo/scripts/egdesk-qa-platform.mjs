import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isOwnedAndPrivate, isSafeWindowsAcl } from '../helper/egdesk-private-files.mjs';
export { isOwnedAndPrivate, isSafeWindowsAcl };

function windowsAcl(target, createNewDirectory = false) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Paths cross the process boundary as data, never interpolated shell code.
  const script = `$ErrorActionPreference='Stop';
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);
$target=$env:EGDESK_QA_ACL_TARGET;
$self=[Security.Principal.WindowsIdentity]::GetCurrent().User;
${createNewDirectory ? `if(Test-Path -LiteralPath $target){throw 'QA destination already exists'};
$acl=New-Object Security.AccessControl.DirectorySecurity;
$acl.SetAccessRuleProtection($true,$false);
$acl.SetOwner($self);
foreach($sid in @($self.Value,'S-1-5-18','S-1-5-32-544')){
$rule=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]$sid,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);
$acl.AddAccessRule($rule)};
[void][IO.Directory]::CreateDirectory($target,$acl);` : ''}
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

export function createPrivateQaTempDirectory(prefix) {
  if (!/^egdesk-[a-z0-9-]+-$/.test(prefix)) throw new Error('Invalid QA temp prefix');
  const root = fs.realpathSync.native(os.tmpdir());
  // Windows must apply the private DACL at creation, not create an inherited
  // writable directory and tighten it afterwards. Existing paths are not ACL
  // mutation targets, including a collision in the random name.
  const created = process.platform === 'win32' ? path.join(root, prefix + randomBytes(8).toString('hex'))
    : fs.mkdtempSync(path.join(root, prefix));
  const acl = process.platform === 'win32' ? windowsAcl(created, true) : null;
  const canonical = fs.realpathSync.native(created);
  if (created !== canonical || path.dirname(canonical) !== root
      || !path.basename(canonical).startsWith(prefix)) throw new Error('Unsafe newly created QA directory');
  // The user's temp parent, existing profiles and existing evidence are never
  // re-permissioned. The Windows descriptor is protected before creation.
  if (process.platform === 'win32') {
    if (!acl.protected || !isSafeWindowsAcl(acl, 0o077)) throw new Error('New QA directory ACL is not private');
  } else fs.chmodSync(canonical, 0o700);
  if (fs.readdirSync(canonical).length || !isOwnedAndPrivate(canonical, fs.lstatSync(canonical), 0o077)) {
    throw new Error(`New QA directory is not empty and private: ${canonical}`);
  }
  return canonical;
}
