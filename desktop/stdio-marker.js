/**
 * Measurement only (TT-3507, do not merge). Imported first by main.js, so it
 * is the first of Zelos's own code to run. With ZELOS_MCP_STDIO_MARKER=1, which
 * only scripts/check-mcp-stdio.mjs sets, `Zelos mcp` writes `#` to stdout here,
 * and the check reports whether Electron's stray \r\n comes before or after it.
 */
if (process.env.ZELOS_MCP_STDIO_MARKER === '1' && process.argv.includes('mcp')) process.stdout.write('#');
