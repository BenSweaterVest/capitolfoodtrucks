export async function onRequestPost(context) {
    const { request, env } = context;
    
    try {
        const { content, password } = await request.json();
        
        // Verify password
        if (password !== env.SAVE_PASSWORD) {
            return new Response('Unauthorized', { status: 401 });
        }

        // Get current file SHA from GitHub
        const repoInfo = {
            owner: env.GITHUB_OWNER,
            repo: env.GITHUB_REPO,
            path: 'index.html'
        };

        const getCurrentFile = await fetch(
            `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/contents/${repoInfo.path}`,
            {
                headers: {
                    'Authorization': `token ${env.GITHUB_TOKEN}`,
                    'User-Agent': 'TiddlyWiki-Cloudflare-Saver'
                }
            }
        );

        const currentFile = await getCurrentFile.json();
        
        // Update file on GitHub
        const updateResponse = await fetch(
            `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/contents/${repoInfo.path}`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': `token ${env.GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'TiddlyWiki-Cloudflare-Saver'
                },
                body: JSON.stringify({
                    message: `Update TiddlyWiki - ${new Date().toISOString()}`,
                    content: btoa(unescape(encodeURIComponent(content))),
                    sha: currentFile.sha
                })
            }
        );

        if (!updateResponse.ok) {
            throw new Error(`GitHub API error: ${updateResponse.statusText}`);
        }

        return new Response('Saved successfully', { status: 200 });
        
    } catch (error) {
        console.error('Save error:', error);
        return new Response(`Save failed: ${error.message}`, { status: 500 });
    }
}
