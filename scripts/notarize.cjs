/**
 * macOS notarization hook for electron-builder.
 * Called automatically after code signing during `electron-builder --mac`.
 *
 * Required environment variables:
 *   APPLE_ID                    — Apple Developer email
 *   APPLE_APP_SPECIFIC_PASSWORD — App-specific password (not your Apple ID password)
 *   APPLE_TEAM_ID               — Apple Developer Team ID
 *
 * The signing certificate (Developer ID Application) must be in your Keychain
 * or provided via CSC_LINK / CSC_KEY_PASSWORD env vars.
 */
const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  // Skip notarization if credentials are not configured
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    console.log("Skipping notarization: APPLE_ID or APPLE_APP_SPECIFIC_PASSWORD not set");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarizing ${appPath}...`);

  await notarize({
    tool: "notarytool",
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });

  console.log("Notarization complete.");
};
