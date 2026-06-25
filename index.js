#!/usr/bin/env node

const { Client } = require('tdl');
const { TDLib } = require('tdl-tdlib-addon');
const { getTdjson } = require('prebuilt-tdlib');
const tdl = require('tdl');

// Configure tdl to use prebuilt TDLib
try {
  tdl.configure({ tdjson: getTdjson() });
} catch (error) {
  // If prebuilt-tdlib fails, try system library
  // This allows fallback to system-installed TDLib
}

// Parse command line arguments
const args = process.argv.slice(2);
const debugMode = args.includes('--debug');
const proxyArg = args.find(arg => arg !== '--debug');

// Parse proxy URL from tg:// or https://t.me/proxy format
function parseProxyUrl(url) {
  const tgPattern = /^tg:\/\/proxy\?/;
  const httpsPattern = /^https?:\/\/(www\.)?t\.me\/proxy\?/;
  
  if (!tgPattern.test(url) && !httpsPattern.test(url)) {
    throw new Error('Invalid proxy URL format');
  }

  const params = new URLSearchParams(url.split('?')[1]);
  const server = params.get('server');
  const port = parseInt(params.get('port'), 10);
  const secret = params.get('secret');

  if (!server || !port || !secret) {
    throw new Error('Missing required parameters: server, port, or secret');
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error('Invalid port number');
  }

  return { server, port, secret };
}

// Normalize secret: detect hex vs base64, decode, convert to hex
function normalizeSecret(secret) {
  // Check if secret contains only hex characters
  const hexPattern = /^[0-9a-fA-F]+$/;
  const isHex = hexPattern.test(secret);

  let bytes;
  
  if (isHex) {
    // Already hex, convert to bytes then back to lowercase hex for consistency
    if (secret.length % 2 !== 0) {
      throw new Error('INVALID_SECRET');
    }
    try {
      bytes = Buffer.from(secret, 'hex');
    } catch (error) {
      throw new Error('INVALID_SECRET');
    }
  } else {
    // Treat as URL-safe Base64
    // Normalize: - → +, _ → /
    let normalized = secret.replace(/-/g, '+').replace(/_/g, '/');
    
    // Add padding to multiple of 4
    const padding = normalized.length % 4;
    if (padding !== 0) {
      normalized += '='.repeat(4 - padding);
    }

    try {
      bytes = Buffer.from(normalized, 'base64');
    } catch (error) {
      throw new Error('INVALID_SECRET');
    }
  }

  // Convert bytes to lowercase hex string
  return bytes.toString('hex').toLowerCase();
}

// Extract detailed error message from TDLib error
function extractErrorMessage(error) {
  let errorMsg = 'Unknown error';
  const errorStr = JSON.stringify(error);
  
  // Check if it's a TDLib error response
  if (error.response) {
    const response = error.response;
    
    // TDLib error format: { _: 'error', code: 400, message: '...' }
    if (response._ === 'error') {
      const code = response.code;
      const msg = response.message || '';
      errorMsg = `Error ${code}: ${msg}`;
      
      // Provide more specific messages for common error codes
      if (code === 400) {
        const lowerMsg = msg.toLowerCase();
        if (lowerMsg.includes('secret')) {
          errorMsg = 'INVALID_SECRET: Secret format is invalid or incorrect';
        } else if (lowerMsg.includes('port')) {
          errorMsg = 'INVALID_PORT: Port number is invalid or out of range';
        } else if (lowerMsg.includes('server') || lowerMsg.includes('hostname')) {
          errorMsg = 'INVALID_SERVER: Server address is invalid or unreachable';
        } else {
          errorMsg = `INVALID_PROXY: ${msg}`;
        }
      } else if (code === 406 || code === 401) {
        errorMsg = 'CONNECTION_FAILED: Could not establish connection to proxy server';
      } else if (code === 500 || code === 503) {
        errorMsg = 'PROXY_ERROR: Proxy server returned an error or is unavailable';
      } else {
        errorMsg = `Error ${code}: ${msg || 'Unknown TDLib error'}`;
      }
    } 
    // Handle other response formats
    else if (typeof response === 'string') {
      errorMsg = response;
    } else if (response.error) {
      errorMsg = response.error.message || JSON.stringify(response.error);
    } else if (response.message) {
      errorMsg = response.message;
    }
  }
  
  // Check error.message for various error types
  if (error.message) {
    const msg = error.message;
    
    // Timeout errors
    if (msg.includes('Timeout') || msg.includes('timeout')) {
      errorMsg = 'TIMEOUT: Proxy did not respond within 15 seconds';
    }
    // Network connection errors
    else if (msg.includes('ECONNREFUSED') || msg.includes('Connection refused')) {
      errorMsg = 'CONNECTION_REFUSED: Proxy server refused the connection (server might be down or port is closed)';
    } else if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo') || msg.includes('DNS')) {
      errorMsg = 'DNS_ERROR: Cannot resolve server hostname to IP address';
    } else if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
      errorMsg = 'TIMEOUT: Connection to proxy server timed out';
    } else if (msg.includes('EHOSTUNREACH') || msg.includes('No route to host')) {
      errorMsg = 'NETWORK_ERROR: No route to proxy server';
    } else if (msg.includes('ECONNRESET') || msg.includes('Connection reset')) {
      errorMsg = 'CONNECTION_RESET: Connection to proxy server was reset';
    }
    // Use the message if we haven't found a specific error type
    else if (!error.response) {
      errorMsg = msg;
    }
  }
  
  // Fallback: try to extract any useful information
  if (errorMsg === 'Unknown error' && errorStr) {
    // Try to find error message in the stringified error
    const msgMatch = errorStr.match(/"message":\s*"([^"]+)"/);
    if (msgMatch) {
      errorMsg = msgMatch[1];
    } else if (errorStr.length < 200) {
      errorMsg = errorStr;
    }
  }
  
  return errorMsg;
}

// Main verification function
async function verifyProxy(server, port, hexSecret) {
  // TDLib can add and ping proxies before authorization
  // We use placeholder values - actual auth is not needed for proxy operations
  
  // Get TDLib DLL path from prebuilt-tdlib
  let tdlibPath;
  try {
    tdlibPath = getTdjson();
  } catch (error) {
    // Fallback to default
    tdlibPath = null;
  }
  
  // Create TDLib instance - it should find the DLL via tdl.configure()
  const tdlib = new TDLib(tdlibPath || undefined);
  const client = new Client(tdlib, {
    apiId: 12345,
    apiHash: '0123456789abcdef0123456789abcdef',
    useTestDc: false,
    databaseDirectory: '/tmp/tdlib-db',
    filesDirectory: '/tmp/tdlib-files',
  });

  try {
    await client.connect();
    
    if (debugMode) {
      console.error(`[DEBUG] Connected to TDLib`);
      console.error(`[DEBUG] Server: ${server}`);
      console.error(`[DEBUG] Port: ${port}`);
      console.error(`[DEBUG] Secret (hex, first 32 chars): ${hexSecret.substring(0, 32)}...`);
      console.error(`[DEBUG] Secret length: ${hexSecret.length / 2} bytes`);
    }

    // Add proxy
    let addProxyResult;
    try {
      addProxyResult = await client.invoke({
        _: 'addProxy',
        server: server,
        port: port,
        enable: true,
        type: {
          _: 'proxyTypeMtproto',
          secret: hexSecret
        }
      });
    } catch (error) {
      const errorMsg = extractErrorMessage(error);
      if (errorMsg.includes('INVALID_SECRET')) {
        console.log('INVALID_SECRET');
        process.exit(1);
      }
      console.log(`NO: ${errorMsg}`);
      if (debugMode) {
        console.error(`[DEBUG] addProxy error:`, error);
        if (error.response) {
          console.error(`[DEBUG] TDLib response:`, JSON.stringify(error.response, null, 2));
        }
      }
      process.exit(2);
    }

    if (debugMode) {
      console.error(`[DEBUG] addProxy result:`, JSON.stringify(addProxyResult, null, 2));
    }

    if (addProxyResult._ !== 'proxy') {
      const errorMsg = extractErrorMessage({ response: addProxyResult });
      console.log(`NO: addProxy failed - ${errorMsg}`);
      if (debugMode) {
        console.error(`[DEBUG] addProxy returned:`, JSON.stringify(addProxyResult, null, 2));
      }
      process.exit(2);
    }

    const proxyId = addProxyResult.id;

    // Ping proxy with timeout
    const pingPromise = client.invoke({
      _: 'pingProxy',
      proxy_id: proxyId
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timeout')), 15000); // 15 second timeout
    });

    try {
      const pingResult = await Promise.race([pingPromise, timeoutPromise]);
      
      if (debugMode) {
        console.error(`[DEBUG] pingProxy result:`, JSON.stringify(pingResult, null, 2));
      }

      // pingProxy returns empty object on success
      console.log('OK');
      process.exit(0);
    } catch (error) {
      const errorMsg = extractErrorMessage(error);
      console.log(`NO: ${errorMsg}`);
      if (debugMode) {
        console.error(`[DEBUG] pingProxy error:`, error);
        if (error.response) {
          console.error(`[DEBUG] TDLib response:`, JSON.stringify(error.response, null, 2));
        }
      }
      process.exit(2);
    }
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    
    // Check if it's a connection error to TDLib itself
    if (error.message && (error.message.includes('tdjson') || error.message.includes('TDLib'))) {
      console.log(`NO: TDLIB_ERROR: ${errorMsg}`);
    } else {
      console.log(`NO: ${errorMsg}`);
    }
    
    if (debugMode) {
      console.error(`[DEBUG] Error:`, error);
      if (error.response) {
        console.error(`[DEBUG] TDLib response:`, JSON.stringify(error.response, null, 2));
      }
      if (error.stack) {
        console.error(`[DEBUG] Stack trace:`, error.stack);
      }
    }
    process.exit(2);
  } finally {
    try {
      await client.close();
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}

// Main execution
async function main() {
  let proxyUrl;

  if (proxyArg) {
    proxyUrl = proxyArg;
  } else {
    // Read from stdin
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    let lineReceived = false;
    proxyUrl = await new Promise((resolve) => {
      rl.on('line', (line) => {
        lineReceived = true;
        resolve(line.trim());
        rl.close();
      });
      rl.on('close', () => {
        if (!lineReceived) resolve(null);
      });
    });
  }

  if (!proxyUrl) {
    console.error('Usage: node index.js [--debug] <proxy_url>');
    console.error('   or: echo "<proxy_url>" | node index.js [--debug]');
    process.exit(1);
  }

  try {
    const { server, port, secret } = parseProxyUrl(proxyUrl);
    
    if (debugMode) {
      console.error(`[DEBUG] Parsed URL:`);
      console.error(`[DEBUG]   Server: ${server}`);
      console.error(`[DEBUG]   Port: ${port}`);
      console.error(`[DEBUG]   Secret (raw): ${secret.substring(0, 50)}...`);
      console.error(`[DEBUG]   Secret format: ${/^[0-9a-fA-F]+$/.test(secret) ? 'hex' : 'base64'}`);
    }

    const hexSecret = normalizeSecret(secret);
    await verifyProxy(server, port, hexSecret);
  } catch (error) {
    if (error.message === 'INVALID_SECRET' || error.message.includes('INVALID_SECRET')) {
      console.log('INVALID_SECRET');
      if (debugMode) {
        console.error(`[DEBUG] Error details:`, error.message);
      }
      process.exit(1);
    } else {
      if (debugMode) {
        console.error(`[DEBUG] Error:`, error.message || error);
      }
      console.log('NO');
      process.exit(2);
    }
  }
}

main().catch((error) => {
  if (debugMode) {
    console.error(`[DEBUG] Unhandled error:`, error);
  }
  console.log('NO');
  process.exit(2);
});

