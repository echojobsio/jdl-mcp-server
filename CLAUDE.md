# JDL MCP Server

## Architecture
Pure HTTP client of the JDL public API. No MongoDB, no internal imports. All requests go through api.jobdatalake.com.

## Stack
TypeScript + @modelcontextprotocol/sdk. stdio transport for local use.

## Tools
- search_jobs — keyword/semantic search with filters
- get_job — full job details by handle
- get_company — company profile
- find_similar_jobs — vector similarity search
