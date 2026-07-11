/**
 * Single source of truth for the cchub MCP server's identifiers. The
 * allowed-tools name `mcp__cchub__feed_image` is the synthesis of the
 * server name and tool name, and it is referenced in three otherwise-decoupled
 * places: the mcpServers key in the generated per-session config JSON, the
 * McpServer instance name, and the `--allowedTools` flag passed to claude.
 * Deriving the synthesized name here keeps those three in lockstep — drift
 * between them would silently disable the tool.
 */
export const MCP_SERVER_NAME = 'cchub';
export const FEED_IMAGE_TOOL = 'feed_image';

/** `mcp__<server>__<tool>` is claude's namespacing for MCP tools in --allowedTools. */
export const FEED_IMAGE_ALLOWED_TOOL = `mcp__${MCP_SERVER_NAME}__${FEED_IMAGE_TOOL}`;

/** Image extensions claude can attach from a pasted path. Lower-case, no dot. */
export const FEED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;

/** Sanity cap so a mistyped path to a huge file can't be force-pasted. */
export const FEED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
