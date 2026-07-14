#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { get } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomicSync } from "../src/artifact-io.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DASHBOARD_SCRIPT = join(ROOT, "tools", "pilot-dashboard.mjs");
const DASHBOARD_DIR = join(ROOT, "work", "private", "pilot-agent", "dashboard");
const SERVICE_STATE = join(DASHBOARD_DIR, "dashboard-service.json");
const OUT_LOG = join(DASHBOARD_DIR, "dashboard-server.out.log");
const ERR_LOG = join(DASHBOARD_DIR, "dashboard-server.err.log");

const parsed = parseArgs(process.argv.slice(2));
const command = parsed.command;
const host = parsed.options.host ?? "127.0.0.1";
const port = Number(parsed.options.port ?? 8787);
const url = `http://${host}:${port}`;

mkdirSync(DASHBOARD_DIR, { recursive: true });

try {
  if (command === "start") {
    const result = await startDashboard({ restart: false });
    printResult(result);
  } else if (command === "restart" || command === "reset") {
    const stopResult = await stopDashboard({ takePort: true });
    if (!stopResult.ok) {
      printResult(stopResult);
      process.exitCode = 1;
      process.exit();
    }
    const result = await startDashboard({ restart: true });
    printResult(result);
  } else if (command === "stop") {
    printResult(await stopDashboard({ takePort: true }));
  } else if (command === "status") {
    printResult(await dashboardStatus());
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function startDashboard({ restart }) {
  const current = await healthCheck();
  if (current.ok && !restart) {
    return {
      ok: true,
      message: `Pilot dashboard is already running at ${url}.`,
      pid: listenerPids(port)[0] ?? readServiceState()?.pid ?? null,
      url
    };
  }

  const listeners = listenerPids(port);
  if (listeners.length > 0) {
    throw new Error(`Port ${port} is still occupied by PID(s) ${listeners.join(", ")}. Run restart/reset to reclaim it.`);
  }

  const outFd = openSync(OUT_LOG, "a");
  const errFd = openSync(ERR_LOG, "a");
  const args = [
    DASHBOARD_SCRIPT,
    "--host",
    host,
    "--port",
    String(port),
    ...parsed.passThrough
  ];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, errFd]
  });
  closeSync(outFd);
  closeSync(errFd);
  child.unref();

  const state = {
    pid: child.pid,
    host,
    port,
    url,
    startedAt: new Date().toISOString(),
    command: [process.execPath, ...args].join(" "),
    logs: {
      stdout: OUT_LOG,
      stderr: ERR_LOG
    }
  };
  writeJsonAtomicSync(SERVICE_STATE, state);

  const ready = await waitForHealth(90_000);
  if (!ready.ok) {
    const tail = [tailFile(ERR_LOG, 20), tailFile(OUT_LOG, 10)].filter(Boolean).join("\n");
    throw new Error(`Dashboard did not become ready on ${url}.${tail ? `\n\nRecent dashboard log:\n${tail}` : ""}`);
  }

  return {
    ok: true,
    message: `Pilot dashboard running at ${url}.`,
    pid: child.pid,
    url,
    logs: state.logs
  };
}

async function stopDashboard({ takePort }) {
  const pids = new Set();
  const saved = readServiceState();
  if (saved?.pid) pids.add(Number(saved.pid));
  const listeners = listenerPids(port);
  if (takePort) {
    for (const pid of listeners) pids.add(Number(pid));
  }

  const stopped = [];
  const failed = [];
  for (const pid of [...pids].filter((value) => Number.isFinite(value) && value > 0)) {
    const result = stopProcessTree(pid);
    if (result.ok || !isProcessAlive(pid)) stopped.push(pid);
    else failed.push({ pid, result });
  }

  const stillListening = listenerPids(port);
  if (failed.length > 0 || stillListening.length > 0) {
    return {
      ok: false,
      message: `Dashboard stop was incomplete. Still listening on ${port}: ${stillListening.join(", ") || "none"}.`,
      stopped,
      failed,
      stillListening
    };
  }

  writeJsonAtomicSync(SERVICE_STATE, {
    pid: null,
    host,
    port,
    url,
    stoppedAt: new Date().toISOString(),
    stopped
  });

  return {
    ok: true,
    message: stopped.length
      ? `Stopped dashboard process(es): ${stopped.join(", ")}.`
      : `No dashboard process was listening on ${url}.`,
    stopped
  };
}

async function dashboardStatus() {
  const health = await healthCheck();
  const listeners = listenerPids(port);
  const saved = readServiceState();
  return {
    ok: health.ok,
    message: health.ok
      ? `Pilot dashboard is running at ${url}.`
      : `Pilot dashboard is not responding at ${url}.`,
    url,
    pids: listeners,
    savedPid: saved?.pid ?? null,
    error: health.error ?? null
  };
}

async function waitForHealth(timeoutMs) {
  const started = Date.now();
  let last = { ok: false, error: "not checked" };
  while (Date.now() - started < timeoutMs) {
    last = await healthCheck();
    if (last.ok) return last;
    await sleep(250);
  }
  return last;
}

function healthCheck() {
  return new Promise((resolveHealth) => {
    const request = get(`${url}/api/health`, { timeout: 10_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          resolveHealth({ ok: false, error: `HTTP ${response.statusCode}` });
          return;
        }
        try {
          const data = JSON.parse(body);
          resolveHealth({
            ok: Boolean(data?.ok && data.cwd && data.pid),
            data
          });
        } catch (error) {
          resolveHealth({ ok: false, error: error.message });
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("request timed out"));
    });
    request.on("error", (error) => {
      resolveHealth({ ok: false, error: error.message });
    });
  });
}

function listenerPids(targetPort) {
  if (process.platform === "win32") {
    const result = spawnSync("netstat.exe", ["-ano"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) return [];
    const matcher = new RegExp(`(^|:)${escapeRegExp(String(targetPort))}\\s+`, "u");
    const pids = [];
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (!line.includes("LISTENING")) continue;
      if (!matcher.test(line)) continue;
      const pid = Number(line.trim().split(/\s+/u).at(-1));
      if (Number.isFinite(pid)) pids.push(pid);
    }
    return [...new Set(pids)];
  }

  const result = spawnSync("sh", ["-lc", `lsof -ti tcp:${Number(targetPort)} -sTCP:LISTEN 2>/dev/null`], {
    encoding: "utf8"
  });
  if (result.status !== 0 && !result.stdout.trim()) return [];
  return [...new Set(result.stdout.split(/\s+/u).map(Number).filter(Number.isFinite))];
}

function stopProcessTree(pid) {
  if (process.platform === "win32") {
    // Keep detached training loops alive when only the dashboard server is restarted.
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], {
      encoding: "utf8",
      windowsHide: true
    });
    const alreadyStopped = result.status !== 0 && /not found|not running|no running instance/iu.test(`${result.stdout}\n${result.stderr}`);
    return {
      ok: result.status === 0 || alreadyStopped,
      status: result.status,
      stdout: result.stdout?.trim() ?? "",
      stderr: result.stderr?.trim() ?? result.error?.message ?? ""
    };
  }

  if (!isProcessAlive(pid)) return { ok: true, message: "process already stopped" };

  try {
    process.kill(pid, "SIGTERM");
    return { ok: true };
  } catch (error) {
    return { ok: false, stderr: error.message };
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function readServiceState() {
  if (!existsSync(SERVICE_STATE)) return null;
  try {
    return JSON.parse(readFileSync(SERVICE_STATE, "utf8"));
  } catch {
    return null;
  }
}

function tailFile(path, lines) {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").split(/\r?\n/u).slice(-lines).join("\n").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(rawArgs) {
  const args = [...rawArgs];
  const known = new Set(["start", "stop", "restart", "reset", "status"]);
  const command = known.has(args[0]) ? args.shift() : "status";
  const options = {};
  const passThrough = [];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--") {
      passThrough.push(...args);
      break;
    }
    if (arg === "--host" || arg === "--port") {
      options[arg.slice(2)] = args.shift();
      continue;
    }
    passThrough.push(arg);
  }
  return { command, options, passThrough };
}

function printResult(result) {
  const lines = [
    result.ok ? "OK" : "ERROR",
    result.message,
    result.url ? `URL: ${result.url}` : null,
    result.pid ? `PID: ${result.pid}` : null,
    result.pids?.length ? `Listening PID(s): ${result.pids.join(", ")}` : null,
    result.logs ? `Logs: ${result.logs.stdout} | ${result.logs.stderr}` : null,
    result.error ? `Error: ${result.error}` : null,
    result.failed?.length ? `Failed stop details: ${result.failed.map((row) => {
      const detail = row.result?.stderr || row.result?.stdout || `status ${row.result?.status ?? "unknown"}`;
      return `PID ${row.pid}: ${detail}`;
    }).join(" | ")}` : null
  ].filter(Boolean);
  console.log(lines.join("\n"));
  if (!result.ok) process.exitCode = 1;
}

function usage() {
  console.log(`Usage:
  node tools/pilot-dashboard-service.mjs start [--host 127.0.0.1] [--port 8787] [-- <dashboard args>]
  node tools/pilot-dashboard-service.mjs restart [--host 127.0.0.1] [--port 8787] [-- <dashboard args>]
  node tools/pilot-dashboard-service.mjs stop [--host 127.0.0.1] [--port 8787]
  node tools/pilot-dashboard-service.mjs status [--host 127.0.0.1] [--port 8787]`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
