#!/usr/bin/env node
/**
 * Lightweight MCP stdio shim that proxies to the remote Grain MCP endpoint
 * but strips outputSchema declarations from tools so Cursor's strict client
 * will accept unstructured responses.
 *
 * Usage:
 *   node mcp-shim.js
 *
 * The script spawns `npx -y mcp-remote https://api.grain.com/_/mcp` and
 * mediates JSON-RPC messages between Cursor (stdin/stdout) and the remote.
 *
 * This shim is designed to work with Cursor's MCP client and the Grain MCP endpoint.
 */

const { spawn, exec } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const execAsync = promisify(exec);

// Remote MCP endpoint
const MCP_REMOTE_URL = "https://api.grain.com/_/mcp";

// Open browser with OAuth URL
async function openBrowser(url) {
  const platform = process.platform;
  let command;
  
  if (platform === "darwin") {
    command = `open "${url}"`;
  } else if (platform === "win32") {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  
  try {
    await execAsync(command);
    console.error(`[SHIM] Opened browser for OAuth: ${url}`);
  } catch (err) {
    console.error(`[SHIM] Failed to open browser:`, err);
    console.error(`[SHIM] Please manually open this URL to authenticate: ${url}`);
  }
}

// Extract OAuth URLs from messages or text
function extractOAuthUrl(text) {
  if (!text) return null;
  
  // Look for HTTP/HTTPS URLs that contain OAuth-related keywords
  const urlRegex = /https?:\/\/[^\s"<>{}]+/g;
  const urls = text.match(urlRegex) || [];
  
  for (const url of urls) {
    const lowerUrl = url.toLowerCase();
    if (
      lowerUrl.includes("oauth") ||
      lowerUrl.includes("authorize") ||
      lowerUrl.includes("authorization") ||
      lowerUrl.includes("login") ||
      lowerUrl.includes("auth") ||
      (lowerUrl.includes("grain.com") && (lowerUrl.includes("/oauth") || lowerUrl.includes("/auth")))
    ) {
      // Clean up URL (remove trailing punctuation)
      return url.replace(/[.,;:!?)"'>]+$/, "");
    }
  }
  
  return null;
}

// Simple Content-Length framed JSON-RPC reader/writer (LSP style framing).
function createFramedReader(stream, onMessage, label = "unknown") {
  let buffer = Buffer.alloc(0);
  let totalBytes = 0;

  stream.on("data", (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes <= 1000) { // Only log first 1KB to avoid spam
      console.error(`[SHIM ${label}] Received ${chunk.length} bytes (total: ${totalBytes})`);
      // Log first chunk to see what we're getting
      if (totalBytes === chunk.length) {
        const preview = chunk.toString("utf8").substring(0, Math.min(200, chunk.length));
        console.error(`[SHIM ${label}] First chunk preview: ${preview}`);
      }
    }
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (totalBytes <= 1000) {
          console.error(`[SHIM ${label}] No header end found, buffer length: ${buffer.length}`);
        }
        break;
      }

      const header = buffer.slice(0, headerEnd).toString("utf8");
      if (totalBytes <= 1000) {
        console.error(`[SHIM ${label}] Found header: ${header}`);
      }
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        if (totalBytes <= 1000) {
          console.error(`[SHIM ${label}] No Content-Length match in header`);
        }
        // If we have data but no Content-Length header, it might be non-framed text
        // Skip until we find a proper frame start (Content-Length:)
        const contentLengthIdx = buffer.indexOf("Content-Length:");
        if (contentLengthIdx === -1) {
          // No Content-Length found at all, clear buffer to avoid infinite loop
          const preview = buffer.slice(0, Math.min(200, buffer.length)).toString("utf8");
          console.error(`[SHIM ${label}] Skipping non-framed data: ${preview}`);
          buffer = Buffer.alloc(0);
          break;
        }
        // Skip everything before Content-Length
        buffer = buffer.slice(contentLengthIdx);
        continue;
      }
      const length = parseInt(match[1], 10);
      const totalLength = headerEnd + 4 + length;
      if (buffer.length < totalLength) break; // wait for full body

      const body = buffer.slice(headerEnd + 4, totalLength).toString("utf8");
      buffer = buffer.slice(totalLength);

      try {
        const msg = JSON.parse(body);
        console.error(`[SHIM ${label}] Parsed message: ${msg.method || (msg.id ? `response id=${msg.id}` : 'notification')} ${msg.jsonrpc ? `jsonrpc=${msg.jsonrpc}` : ''}`);
        onMessage(msg);
      } catch (err) {
        console.error(`[SHIM ${label}] Failed to parse MCP message:`, err, "Body:", body.substring(0, 200));
      }
    }
  });

  stream.on("error", (err) => {
    console.error(`[SHIM ${label}] Stream error:`, err);
  });
}

// Read raw JSON messages (newline-delimited, for mcp-remote)
function createRawJSONReader(stream, onMessage, label = "unknown") {
  let buffer = "";
  let totalBytes = 0;

  stream.on("data", (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes <= 1000) {
      console.error(`[SHIM ${label}] Received ${chunk.length} bytes (total: ${totalBytes})`);
    }
    buffer += chunk.toString("utf8");
    
    // Process complete JSON messages (newline-delimited)
    while (true) {
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) break;
      
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      
      if (!line) continue; // Skip empty lines
      
      try {
        const msg = JSON.parse(line);
        console.error(`[SHIM ${label}] Parsed message: ${msg.method || (msg.id ? `response id=${msg.id}` : 'notification')} ${msg.jsonrpc ? `jsonrpc=${msg.jsonrpc}` : ''}`);
        onMessage(msg);
      } catch (err) {
        console.error(`[SHIM ${label}] Failed to parse JSON:`, err, "Line:", line.substring(0, 200));
      }
    }
  });

  stream.on("error", (err) => {
    console.error(`[SHIM ${label}] Stream error:`, err);
  });
}

function writeFramedMessage(stream, msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  stream.write(Buffer.concat([header, body]));
}

// Write raw JSON (for mcp-remote which doesn't use Content-Length framing)
function writeRawJSON(stream, msg) {
  const json = JSON.stringify(msg) + "\n";
  stream.write(json, "utf8");
}

// Transform tool list responses by removing outputSchema to avoid strict checks.
function stripOutputSchemas(msg) {
  if (!msg || msg.result?.tools == null) return msg;
  const tools = msg.result.tools.map((tool) => {
    const { outputSchema, ...rest } = tool || {};
    return rest;
  });
  return {
    ...msg,
    result: {
      ...msg.result,
      tools,
    },
  };
}

function main() {
  // Log that shim is starting
  console.error(`[SHIM] Starting MCP shim for ${MCP_REMOTE_URL}`);
  console.error(`[SHIM] This shim strips outputSchema to make Cursor's strict client accept unstructured responses`);
  
  // Set environment variables for mcp-remote
  // Use project-local cache directory by default
  const projectRoot = path.join(__dirname, '..', '..');
  const defaultCacheDir = path.join(projectRoot, '.mcp-cache');
  const env = {
    ...process.env,
    MCP_REMOTE_CACHE_DIR: process.env.MCP_REMOTE_CACHE_DIR || defaultCacheDir,
    // Try to use a fixed callback port if possible (mcp-remote may not support this, but worth trying)
    // PORT: "45701", // Some tools use this
  };
  
  const child = spawn("npx", ["-y", "mcp-remote", MCP_REMOTE_URL], {
    stdio: ["pipe", "pipe", "pipe"],
    env: env,
  });
  
  console.error(`[SHIM] Using cache directory: ${env.MCP_REMOTE_CACHE_DIR}`);

  // Ensure streams are not buffered
  if (child.stdin.setDefaultEncoding) {
    child.stdin.setDefaultEncoding("utf8");
  }
  process.stdout.setDefaultEncoding("utf8");

  let cursorToRemote = 0;
  let remoteToCursor = 0;

  // Forward messages from Cursor -> remote.
  // Cursor actually sends raw JSON (newline-delimited), same as mcp-remote expects
  createRawJSONReader(process.stdin, (msg) => {
    cursorToRemote++;
    try {
      // Log important messages for debugging
      if (msg.method === "initialize" || msg.method === "tools/list") {
        console.error(`[SHIM] Cursor→Remote: ${msg.method} id=${msg.id || 'notification'}`);
      }
      // mcp-remote expects raw JSON, and Cursor is also sending raw JSON
      writeRawJSON(child.stdin, msg);
    } catch (err) {
      console.error(`[SHIM] Error forwarding to remote:`, err);
    }
  }, "Cursor→Remote");

  // Forward messages from remote -> Cursor, stripping schemas on tool list.
  // mcp-remote sends raw JSON (newline-delimited), and Cursor also expects raw JSON
  createRawJSONReader(child.stdout, (msg) => {
    remoteToCursor++;
    try {
      // Log important messages for debugging
      if (msg.method === "initialize" || msg.result?.tools || msg.error) {
        console.error(`[SHIM] Remote→Cursor: ${msg.method || msg.id ? `id=${msg.id}` : 'notification'} ${msg.result?.tools ? `tools=${msg.result.tools.length}` : ''} ${msg.error ? `error=${msg.error.code}` : ''}`);
      }
      
      // Check for OAuth URLs in the message
      const msgStr = JSON.stringify(msg);
      const oauthUrl = extractOAuthUrl(msgStr);
      if (oauthUrl) {
        openBrowser(oauthUrl);
      }
      
      // Also check in error messages or prompts
      if (msg.error) {
        const errorStr = JSON.stringify(msg.error);
        const errorOAuthUrl = extractOAuthUrl(errorStr);
        if (errorOAuthUrl) {
          openBrowser(errorOAuthUrl);
        }
      }
      
      const transformed =
        msg?.result?.tools != null ? stripOutputSchemas(msg) : msg;
      
      // Log if we're stripping schemas
      if (transformed !== msg) {
        console.error(`[SHIM] Stripped outputSchema from ${msg.result.tools.length} tools`);
      }
      
      // Cursor expects raw JSON, not Content-Length framed
      writeRawJSON(process.stdout, transformed);
    } catch (err) {
      console.error(`[SHIM] Error forwarding to Cursor:`, err);
    }
  }, "Remote→Cursor");

  // Monitor stderr for OAuth URLs and callback issues (mcp-remote prints to stderr)
  let stderrBuffer = "";
  let oauthUrlFound = false;
  let callbackPort = null;
  
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    
    // Detect callback port
    const portMatch = text.match(/callback port:\s*(\d+)/i) || text.match(/port:\s*(\d+)/i);
    if (portMatch && !callbackPort) {
      callbackPort = portMatch[1];
      console.error(`[SHIM] Detected OAuth callback port: ${callbackPort}`);
    }
    
    // Check for OAuth URLs in stderr output
    if (!oauthUrlFound) {
      const oauthUrl = extractOAuthUrl(stderrBuffer);
      if (oauthUrl) {
        oauthUrlFound = true;
        console.error(`[SHIM] 🔐 OAuth URL detected: ${oauthUrl}`);
        console.error(`[SHIM] Opening browser for authentication...`);
        openBrowser(oauthUrl);
        
        // If callback port is known, provide instructions
        if (callbackPort) {
          console.error(`[SHIM] ⚠️  If browser callback fails, the callback URL should be:`);
          console.error(`[SHIM]    http://localhost:${callbackPort}/oauth/callback`);
          console.error(`[SHIM]    You may need to manually complete OAuth in a terminal instead.`);
        }
        
        stderrBuffer = ""; // Clear buffer after finding URL
      }
    }
    
    // Check for callback errors
    if (text.includes("callback") && (text.includes("failed") || text.includes("error") || text.includes("timeout"))) {
      const projectRoot = path.join(__dirname, '..', '..');
      const cacheDir = process.env.MCP_REMOTE_CACHE_DIR || path.join(projectRoot, '.mcp-cache');
      console.error(`[SHIM] ⚠️  OAuth callback issue detected in stderr`);
      console.error(`[SHIM] 💡 Try pre-authenticating in a terminal:`);
      console.error(`[SHIM]    MCP_REMOTE_CACHE_DIR=${cacheDir} \\`);
      console.error(`[SHIM]    npx -y mcp-remote https://api.grain.com/_/mcp tools/list`);
    }
    
    // Also write to console for visibility
    process.stderr.write(chunk);
  });

  // Handle errors
  child.on("error", (err) => {
    console.error(`[SHIM] Child process error:`, err);
    process.exit(1);
  });

  process.stdin.on("error", (err) => {
    console.error(`[SHIM] stdin error:`, err);
  });

  process.stdout.on("error", (err) => {
    console.error(`[SHIM] stdout error:`, err);
  });

  child.on("exit", (code, signal) => {
    console.error(`[SHIM] mcp-remote exited code=${code} signal=${signal ?? ""} (forwarded ${cursorToRemote}→${remoteToCursor} msgs)`);
    process.exit(code ?? 1);
  });
}

main();
