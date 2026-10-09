// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Seth Johnston.
//
// The Backup screen (PLAN §3): S3 settings (the secret goes to Electron safeStorage in the main
// process and never comes back to this window), Test connection, Back up now with progress and
// Stop, last-backup time, optional automatic backups, a bandwidth limit, and Restore into a NEW
// folder. Jobs run as rclone rc jobs inside the helper.

import { css } from "@emotion/react";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@mui/material";
import { Trans } from "@lingui/macro";
import { Project } from "../../model/Project/Project";
import { lameta_dark_blue, error_color } from "../../containers/theme";
import { backupApi, PublicBackupSettings, LastBackupRecord } from "./BackupApiAccess";
import { helperApi, HelperCallFailed } from "../helper/HelperApiAccess";
import { EMPTY_PROGRESS, formatProgress, JobProgress, JobRunner } from "./backupJob";

const EMPTY: PublicBackupSettings = {
  endpoint: "",
  region: "",
  bucket: "",
  prefix: "",
  accessKeyId: "",
  bwlimit: "",
  forcePathStyle: false,
  autoBackupMinutes: 0,
  hasSecret: false,
  encryptionAvailable: true
};

const formCss = css`
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 720px;
  label {
    display: grid;
    grid-template-columns: 180px 1fr;
    align-items: center;
    gap: 8px;
  }
  input[type="text"],
  input[type="password"],
  input[type="number"] {
    padding: 4px 6px;
    border: 1px solid #bbb;
    border-radius: 3px;
    font-size: 13px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .status {
    color: ${lameta_dark_blue};
    min-height: 1.2em;
  }
  .error {
    color: ${error_color};
  }
  h2 {
    margin: 12px 0 4px 0;
    font-size: 15px;
  }
  .hint {
    color: #555;
    font-size: 12px;
  }
`;

function describeError(e: unknown): string {
  if (e instanceof HelperCallFailed) return e.message;
  return (e as Error)?.message ?? String(e);
}

export const BackupTab: React.FunctionComponent<{ project: Project }> = ({ project }) => {
  const [settings, setSettings] = useState<PublicBackupSettings>(EMPTY);
  const [secret, setSecret] = useState("");
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<JobProgress>(EMPTY_PROGRESS);
  const [last, setLast] = useState<LastBackupRecord | null>(null);
  const [remoteProjects, setRemoteProjects] = useState<string[]>([]);
  const [restoreName, setRestoreName] = useState("");
  const runner = useRef<JobRunner | null>(null);
  const configured = useRef(false);

  useEffect(() => {
    runner.current = new JobRunner(helperApi, setProgress);
    backupApi.load().then(setSettings).catch((e) => setError(describeError(e)));
    backupApi.lastBackup(project.directory).then(setLast).catch(() => {});
    return () => runner.current?.dispose();
  }, [project.directory]);

  const field = (key: keyof PublicBackupSettings, label: React.ReactNode, type = "text") => (
    <label>
      <span>{label}</span>
      <input
        type={type}
        value={String(settings[key] ?? "")}
        onChange={(e) => {
          setSettings({ ...settings, [key]: e.target.value });
          setDirty(true);
        }}
      />
    </label>
  );

  async function save(): Promise<boolean> {
    setError("");
    const r = await backupApi.save(settings, secret === "" ? undefined : secret);
    setSettings(r.result);
    if (r.error) {
      setError(r.error);
      return false;
    }
    setSecret("");
    setDirty(false);
    configured.current = false;
    setMessage("Settings saved.");
    return true;
  }

  async function ensureConfigured(): Promise<boolean> {
    if (dirty || secret !== "") {
      if (!(await save())) return false;
    }
    if (configured.current) return true;
    const r = await backupApi.configure();
    if (r.error) {
      setError(r.error);
      return false;
    }
    configured.current = true;
    return true;
  }

  async function testConnection() {
    setBusy(true);
    setError("");
    setMessage("Testing connection...");
    try {
      if (!(await ensureConfigured())) return;
      const r = await helperApi.call<{ ok: boolean; message?: string; entries?: number }>("backupTestConnection", {}, 60_000);
      if (r.ok) setMessage(`Connected. ${r.entries ?? 0} item(s) at the backup location.`);
      else setError(`Could not connect: ${r.message ?? "unknown error"}`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function backUpNow() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (!(await ensureConfigured())) return;
      project.saveAllFilesInFolder();
      const started = await runner.current!.start("backupStart", { projectFolder: project.directory });
      setMessage(`Backing up to ${started.dstFs}...`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  // record the outcome when a backup job finishes
  useEffect(() => {
    if (!progress.finished || !progress.jobid) return;
    const rec: LastBackupRecord = {
      at: new Date().toISOString(),
      ok: !!progress.success,
      message: progress.success ? "ok" : progress.error,
      bytes: progress.bytes,
      files: progress.transfers
    };
    if (message.startsWith("Backing up")) {
      backupApi.recordLastBackup(project.directory, rec).then(() => setLast(rec)).catch(() => {});
      setMessage(progress.success ? "Backup finished." : "");
      if (!progress.success) setError(`Backup failed: ${progress.error}`);
    } else if (message.startsWith("Restoring")) {
      setMessage(progress.success ? "Restore finished." : "");
      if (!progress.success) setError(`Restore failed: ${progress.error}`);
    }
  }, [progress.finished, progress.jobid]);

  // optional automatic backups
  useEffect(() => {
    if (!settings.autoBackupMinutes) return;
    const t = setInterval(() => {
      if (!progress.running && !busy) void backUpNow();
    }, settings.autoBackupMinutes * 60_000);
    return () => clearInterval(t);
  }, [settings.autoBackupMinutes, project.directory]);

  async function loadRemoteProjects() {
    setError("");
    try {
      if (!(await ensureConfigured())) return;
      const names = await helperApi.call<string[]>("backupListProjects", {}, 60_000);
      setRemoteProjects(names);
      if (names.length && !restoreName) setRestoreName(names[0]);
      if (!names.length) setMessage("No backed-up projects found at the backup location.");
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function restore() {
    setError("");
    if (!restoreName) return;
    const dest = await backupApi.chooseFolder("Choose a NEW, empty folder to restore into");
    if (!dest) return;
    setBusy(true);
    try {
      if (!(await ensureConfigured())) return;
      const started = await runner.current!.start("backupRestore", {
        projectName: restoreName,
        destinationFolder: dest,
        openProjectFolder: project.directory
      });
      setMessage(`Restoring ${restoreName} into ${started.destinationFolder}...`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const running = progress.running;

  return (
    <div css={formCss} data-testid="flextext-backup-tab">
      <h2>
        <Trans>Backup to S3-compatible storage</Trans>
      </h2>
      <p className="hint">
        <Trans>
          The whole project folder is copied to the bucket. A backup never deletes anything: files
          overwritten or removed since the last backup are moved into a history folder beside the
          backup. The secret access key is stored encrypted on this computer and is never written to
          a file in plain text.
        </Trans>
      </p>
      {field("endpoint", <Trans>Endpoint URL</Trans>)}
      {field("region", <Trans>Region</Trans>)}
      {field("bucket", <Trans>Bucket</Trans>)}
      {field("prefix", <Trans>Folder (prefix) in bucket</Trans>)}
      {field("accessKeyId", <Trans>Access key ID</Trans>)}
      <label>
        <span>
          <Trans>Secret access key</Trans>
        </span>
        <input
          type="password"
          value={secret}
          placeholder={settings.hasSecret ? "(saved; enter a new one to replace it)" : ""}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
        />
      </label>
      {!settings.encryptionAvailable && (
        <div className="error">
          <Trans>This computer cannot encrypt the secret, so it cannot be saved.</Trans>
        </div>
      )}
      {field("bwlimit", <Trans>Bandwidth limit (e.g. 512k, 2M; empty = none)</Trans>)}
      <label>
        <span>
          <Trans>Use path-style addressing</Trans>
        </span>
        <input
          type="checkbox"
          checked={settings.forcePathStyle}
          onChange={(e) => {
            setSettings({ ...settings, forcePathStyle: e.target.checked });
            setDirty(true);
          }}
        />
      </label>
      <label>
        <span>
          <Trans>Automatic backup every (minutes, 0 = off)</Trans>
        </span>
        <input
          type="number"
          min={0}
          value={settings.autoBackupMinutes}
          onChange={(e) => {
            setSettings({ ...settings, autoBackupMinutes: Number(e.target.value) || 0 });
            setDirty(true);
          }}
        />
      </label>
      <div className="row">
        <Button variant="outlined" disabled={busy || running} onClick={() => void save()}>
          <Trans>Save settings</Trans>
        </Button>
        <Button variant="outlined" disabled={busy || running} onClick={() => void testConnection()}>
          <Trans>Test connection</Trans>
        </Button>
        <Button variant="contained" disabled={busy || running} onClick={() => void backUpNow()} data-testid="flextext-backup-now">
          <Trans>Back up now</Trans>
        </Button>
        {running && (
          <Button variant="outlined" onClick={() => void runner.current?.stop()}>
            <Trans>Stop</Trans>
          </Button>
        )}
      </div>
      <div className="status">{formatProgress(progress) || message}</div>
      {error && <div className="error">{error}</div>}
      <div className="hint">
        {last ? (
          <span>
            <Trans>Last backup:</Trans> {new Date(last.at).toLocaleString()} {last.ok ? "" : `(failed: ${last.message})`}
          </span>
        ) : (
          <Trans>This project has not been backed up from this computer yet.</Trans>
        )}
      </div>

      <h2>
        <Trans>Restore</Trans>
      </h2>
      <p className="hint">
        <Trans>
          A restore always goes into a new, empty folder that you choose. It never overwrites the
          project that is open.
        </Trans>
      </p>
      <div className="row">
        <Button variant="outlined" disabled={busy || running} onClick={() => void loadRemoteProjects()}>
          <Trans>List backed-up projects</Trans>
        </Button>
        <select value={restoreName} onChange={(e) => setRestoreName(e.target.value)} disabled={!remoteProjects.length}>
          {remoteProjects.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <Button variant="outlined" disabled={busy || running || !restoreName} onClick={() => void restore()}>
          <Trans>Restore to a new folder...</Trans>
        </Button>
      </div>
    </div>
  );
};
