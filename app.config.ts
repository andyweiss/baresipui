let version = 'dev';

try {
  // Try to read version from build artifact
  if (process.server && typeof require !== 'undefined') {
    const fs = require('fs');
    const path = require('path');
    const versionFile = path.join(process.cwd(), 'public', 'version.js');
    if (fs.existsSync(versionFile)) {
      const content = fs.readFileSync(versionFile, 'utf-8');
      const match = content.match(/APP_VERSION\s*=\s*'([^']+)'/);
      if (match) {
        version = match[1];
      }
    }
  }
} catch (e) {
  // Fallback to 'dev'
}

export default defineAppConfig({
  version
});
