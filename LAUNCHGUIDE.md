# JobDataLake

## Tagline
Search 1M+ enriched job listings from 20,000+ companies. Free, no signup required.

## Description
JobDataLake MCP server gives AI agents access to over 1 million enriched job listings from 20,000+ companies across 40+ ATS platforms, updated hourly. Every job is enriched with normalized skills, seniority level, job function, salary range (USD), remote type, and location data. Free tier includes 500 calls/day with no signup or API key needed. Available as both a remote server and npm package.

## Setup Requirements
- `JDL_API_KEY` (optional): API key for unlimited access. Without a key, 500 free calls/day are included. Get a key at https://www.jobdatalake.com/register

## Category
Data & Analytics

## Features
- Search 1M+ jobs by keyword, skills, salary, location, seniority, remote type, and more
- AI semantic search for natural language job queries
- Get full job details including description, requirements, and apply link
- Company profiles with industry, size, funding, and career page
- Find similar jobs using AI vector similarity
- Discover available filter values with job counts
- Skills filtering in AND mode (e.g. Python AND AWS AND Kubernetes)
- Location supports continents (Europe, Asia, Latin America), countries, and cities
- Salary normalized to USD for easy comparison
- Updated hourly from 20,000+ company career pages
- Free tier: 500 calls/day, no signup required

## Getting Started
- "Find me remote Python jobs paying over $150k"
- "What are the highest paying remote jobs right now?"
- "Show me senior Kubernetes engineers in Europe"
- "Tell me about Anthropic's open positions"
- "What skills are most in demand for remote jobs?"
- Tool: search_jobs — Search and filter jobs with 15+ parameters
- Tool: get_job — Get full job details by handle
- Tool: get_company — Get company profile by domain
- Tool: find_similar_jobs — Find similar jobs using AI vector similarity
- Tool: get_filter_options — Discover available filter values with counts

## Tags
jobs, job-search, job-data, career, salary, remote-work, hiring, mcp, ai, api, job-listings, skills, job-board, recruitment, employment

## Documentation URL
https://www.jobdatalake.com/docs

## Health Check URL
https://mcp.jobdatalake.com/health
