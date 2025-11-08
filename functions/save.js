/**
 * Cloudflare Function for TiddlyWiki Saver Plugin
 * Save at: functions/save.js in your Cloudflare Pages repository
 *
 * Required Environment Variables:
 * - GITHUB_TOKEN: GitHub Personal Access Token (required)
 *     Fine-grained token (recommended): starts with github_pat_
 *       Permissions: Contents (read/write), Metadata (read)
 *     Classic token: starts with ghp_
 *       Scope: repo
 * - GITHUB_REPO: Repository in format "owner/repo" (required)
 * - SAVE_PASSWORD: Password for authentication (required)
 * - ALLOWED_ORIGINS: Comma-separated allowed origins (optional, defaults to *)
 * - FILE_PATH: Path to save file (optional, defaults to index.html)
 * - MAX_CONTENT_SIZE: Max content size in bytes (optional, defaults to 50MB)
 */

// Simple in-memory rate limiter (resets on cold start)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30; // 30 requests per minute

function checkRateLimit(identifier) {
  const now = Date.now();
  const record = rateLimitMap.get(identifier);

  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(identifier, { windowStart: now, count: 1 });
    return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - 1 };
  }

  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, remaining: 0, resetIn: RATE_LIMIT_WINDOW - (now - record.windowStart) };
  }

  record.count++;
  return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - record.count };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Get configuration from environment variables with safe fallbacks
  const allowedOrigins = env?.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : ['*'];
  const filePath = env?.FILE_PATH || 'index.html';
  const maxContentSize = parseInt(env?.MAX_CONTENT_SIZE || '52428800'); // 50MB default

  // Determine CORS origin
  // Handle 'null' origin (local file access) explicitly
  const requestOrigin = request.headers.get('Origin');
  let allowOrigin;
  if (allowedOrigins.includes('*')) {
    // Wildcard: allow the specific origin (including 'null' for local files)
    allowOrigin = requestOrigin || '*';
  } else if (requestOrigin === 'null' || allowedOrigins.includes('null')) {
    // Explicitly allow local file access
    allowOrigin = 'null';
  } else if (allowedOrigins.includes(requestOrigin)) {
    // Allow specific whitelisted origin
    allowOrigin = requestOrigin;
  } else {
    // Fallback to first allowed origin
    allowOrigin = allowedOrigins[0];
  }

  // Set CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  
  try {
    // Parse request
    const { content, password, timestamp } = await request.json();

    // Rate limiting check
    const clientId = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateCheck = checkRateLimit(clientId);

    if (!rateCheck.allowed) {
      return new Response(JSON.stringify({
        error: 'Rate limit exceeded',
        resetIn: Math.ceil(rateCheck.resetIn / 1000)
      }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Retry-After': Math.ceil(rateCheck.resetIn / 1000).toString()
        }
      });
    }

    // Validate required fields
    if (!content || !password) {
      return new Response(JSON.stringify({
        error: 'Missing required fields: content and password'
      }), {
        status: 400,
        headers: corsHeaders
      });
    }

    // Validate content size
    const contentSize = new Blob([content]).size;
    if (contentSize > maxContentSize) {
      return new Response(JSON.stringify({
        error: `Content too large: ${Math.round(contentSize / 1024 / 1024)}MB exceeds ${Math.round(maxContentSize / 1024 / 1024)}MB limit`
      }), {
        status: 413,
        headers: corsHeaders
      });
    }

    // Validate content is not empty
    if (content.trim().length === 0) {
      return new Response(JSON.stringify({
        error: 'Content cannot be empty'
      }), {
        status: 400,
        headers: corsHeaders
      });
    }

    // Verify password
    if (password !== env.SAVE_PASSWORD) {
      return new Response(JSON.stringify({
        error: 'Invalid password'
      }), {
        status: 401,
        headers: corsHeaders
      });
    }
    
    // Validate environment variables
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      console.error('Missing environment variables');
      return new Response(JSON.stringify({
        error: 'Server configuration error'
      }), {
        status: 500,
        headers: corsHeaders
      });
    }

    // Attempt to save with retry logic for conflicts
    const maxRetries = 3;
    let attempt = 0;
    let lastError = null;

    while (attempt < maxRetries) {
      try {
        // Get current file info to retrieve SHA
        const currentFileResponse = await fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${filePath}`,
          {
            headers: {
              'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
              'User-Agent': 'TiddlyWiki-Cloudflare-Saver/1.0',
              'Accept': 'application/vnd.github.v3+json'
            }
          }
        );
    
        let sha = null;
        if (currentFileResponse.ok) {
          const currentFile = await currentFileResponse.json();
          sha = currentFile.sha;
        } else if (currentFileResponse.status !== 404) {
          // File exists but we got an error (not "not found")
          throw new Error(`Failed to access repository file: ${currentFileResponse.status}`);
        }

        // Prepare content for GitHub (proper base64 encode with UTF-8 handling)
        // Using TextEncoder for proper UTF-8 encoding, then converting to base64
        // Process in chunks to avoid "Maximum call stack size exceeded" for large files
        const utf8Bytes = new TextEncoder().encode(content);
        let binaryString = '';
        const chunkSize = 0x8000; // 32KB chunks to avoid stack overflow
        for (let i = 0; i < utf8Bytes.length; i += chunkSize) {
          const chunk = utf8Bytes.subarray(i, Math.min(i + chunkSize, utf8Bytes.length));
          binaryString += String.fromCharCode.apply(null, chunk);
        }
        const encodedContent = btoa(binaryString);

        // Prepare commit data
        const commitData = {
          message: `Update TiddlyWiki via Cloudflare Saver - ${new Date(timestamp || Date.now()).toISOString()}`,
          content: encodedContent,
          committer: {
            name: 'TiddlyWiki Cloudflare Saver',
            email: 'noreply@cloudflare-saver.local'
          }
        };

        // Include SHA if file exists (for updates)
        if (sha) {
          commitData.sha = sha;
        }

        // Save to GitHub
        const saveResponse = await fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${filePath}`,
          {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
              'User-Agent': 'TiddlyWiki-Cloudflare-Saver/1.0',
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(commitData)
          }
        );

        if (!saveResponse.ok) {
          const errorData = await saveResponse.json().catch(() => ({}));

          // Handle conflict (409) - retry with new SHA
          if (saveResponse.status === 409) {
            attempt++;
            if (attempt < maxRetries) {
              console.log(`Conflict detected, retrying (attempt ${attempt + 1}/${maxRetries})`);
              await new Promise(resolve => setTimeout(resolve, 500 * attempt)); // Exponential backoff
              continue;
            }
          }

          throw new Error(errorData.message || `GitHub API error: ${saveResponse.status}`);
        }

        // Success!
        const saveResult = await saveResponse.json();

        return new Response(JSON.stringify({
          success: true,
          message: 'TiddlyWiki saved successfully',
          commit: saveResult.commit.sha,
          timestamp: new Date().toISOString(),
          attempt: attempt + 1
        }), {
          status: 200,
          headers: corsHeaders
        });

      } catch (error) {
        lastError = error;
        attempt++;

        // If not max retries yet and it's a retryable error, continue
        if (attempt < maxRetries && (error.message.includes('conflict') || error.message.includes('409'))) {
          console.log(`Retry attempt ${attempt}/${maxRetries} after error:`, error.message);
          await new Promise(resolve => setTimeout(resolve, 500 * attempt));
          continue;
        }

        // Non-retryable error or max retries reached
        break;
      }
    }

    // If we got here, all retries failed
    console.error('Save function error after retries:', lastError);
    return new Response(JSON.stringify({
      error: 'Failed to save after multiple attempts: ' + (lastError?.message || 'Unknown error'),
      attempts: attempt
    }), {
      status: 500,
      headers: corsHeaders
    });
    
  } catch (error) {
    console.error('Save function error:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error: ' + error.message 
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

// Handle CORS preflight requests
export async function onRequestOptions(context) {
  try {
    const { request, env } = context;

    // Get allowed origins from environment with safe fallback
    const allowedOrigins = env?.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : ['*'];
    const requestOrigin = request.headers.get('Origin');

    // Determine CORS origin (same logic as POST handler)
    let allowOrigin;
    if (allowedOrigins.includes('*')) {
      // Wildcard: allow the specific origin (including 'null' for local files)
      allowOrigin = requestOrigin || '*';
    } else if (requestOrigin === 'null' || allowedOrigins.includes('null')) {
      // Explicitly allow local file access
      allowOrigin = 'null';
    } else if (allowedOrigins.includes(requestOrigin)) {
      // Allow specific whitelisted origin
      allowOrigin = requestOrigin;
    } else {
      // Fallback to first allowed origin
      allowOrigin = allowedOrigins[0];
    }

    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      }
    });
  } catch (error) {
    // Ensure we always return a valid CORS response, even if there's an error
    console.error('Error in OPTIONS handler:', error);
    const requestOrigin = context?.request?.headers?.get('Origin');
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': requestOrigin || '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      }
    });
  }
}

