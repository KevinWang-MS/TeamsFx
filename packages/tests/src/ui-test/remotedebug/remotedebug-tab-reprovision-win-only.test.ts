/**
 * @author Helly Zhang <v-helzha@microsoft.com>
 */
import * as path from "path";
import { VSBrowser } from "vscode-extension-tester";
import { Timeout } from "../../constants";
import {
  RemoteDebugTestContext,
  runProvision,
  reRunProvision,
  runDeploy,
} from "./remotedebugContext";
import {
  execCommandIfExist,
  createNewProject,
  clearNotifications,
} from "../../vscodeOperation";
import { initPage, validateTab } from "../../playwrightOperation";
import { Env } from "../../utils/env";
import { it } from "../../utils/it";
import {
  cleanUpResourceGroup,
  createResourceGroup,
} from "../../utils/cleanHelper";

describe("Remote debug Tests", function () {
  this.timeout(Timeout.testAzureCase);
  let remoteDebugTestContext: RemoteDebugTestContext;
  let testRootFolder: string;
  let appName: string;
  const appNameCopySuffix = "copy";
  let newAppFolderName: string;
  let projectPath: string;

  beforeEach(async function () {
    // ensure workbench is ready
    this.timeout(Timeout.prepareTestCase);
    remoteDebugTestContext = new RemoteDebugTestContext("tab");
    testRootFolder = remoteDebugTestContext.testRootFolder;
    appName = remoteDebugTestContext.appName;
    newAppFolderName = appName + appNameCopySuffix;
    projectPath = path.resolve(testRootFolder, newAppFolderName);
    await remoteDebugTestContext.before();
  });

  afterEach(async function () {
    this.timeout(Timeout.finishAzureTestCase);
    await remoteDebugTestContext.after();

    //Close the folder and cleanup local sample project
    await execCommandIfExist("Workspaces: Close Workspace", Timeout.webView);
    console.log(`[Successfully] start to clean up for ${projectPath}`);
    await remoteDebugTestContext.cleanUp(
      appName,
      projectPath,
      true,
      false,
      false
    );
  });

  it(
    "[auto] Delete resource group and re-provision for tab project",
    {
      testPlanCaseId: 10744678,
      author: "v-helzha@microsoft.com",
    },
    async function () {
      //create tab project
      const driver = VSBrowser.instance.driver;
      await createNewProject("tab", appName);
      await runProvision(appName);
      await clearNotifications();
      await cleanUpResourceGroup(appName, "dev");
      await createResourceGroup(appName, "dev");
      await reRunProvision();
      await runDeploy();
      const teamsAppId = await remoteDebugTestContext.getTeamsAppId(
        projectPath
      );
      const page = await initPage(
        remoteDebugTestContext.context!,
        teamsAppId,
        Env.username,
        Env.password
      );
      await validateTab(page, Env.displayName, false);
    }
  );
});