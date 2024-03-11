import axios, { AxiosResponse, CancelToken } from "axios";
import * as fs from "fs-extra";
import { EOL } from "os";
import * as path from "path";
import * as vscode from "vscode";
import { SampleUrlInfo } from "./sample";

export async function sendRequestWithTimeout<T>(
  requestFn: (cancelToken: CancelToken) => Promise<AxiosResponse<T>>,
  timeoutInMs: number,
  tryLimits = 1
): Promise<AxiosResponse<T>> {
  const source = axios.CancelToken.source();
  const timeout = setTimeout(() => {
    source.cancel();
  }, timeoutInMs);
  try {
    const res = await sendRequestWithRetry(
      () => requestFn(source.token),
      tryLimits
    );
    clearTimeout(timeout);
    return res;
  } catch (err: unknown) {
    if (axios.isCancel(err)) {
      throw new Error("Request timeout");
    }
    throw err;
  }
}

async function sendRequestWithRetry<T>(
  requestFn: () => Promise<AxiosResponse<T>>,
  tryLimits: number
): Promise<AxiosResponse<T>> {
  // !status means network error, see https://github.com/axios/axios/issues/383
  const canTry = (status: number | undefined) =>
    !status || (status >= 500 && status < 600);

  let status: number | undefined;
  let error: Error;

  for (let i = 0; i < tryLimits && canTry(status); i++) {
    try {
      const res = await requestFn();
      if (res.status === 200 || res.status === 201) {
        return res;
      } else {
        error = new Error(`HTTP Request failed: ${JSON.stringify(res)}`);
      }
      status = res.status;
    } catch (e: any) {
      error = e;
      status = e?.response?.status;
    }
  }

  error ??= new Error(`RequestWithRetry got bad tryLimits: ${tryLimits}`);
  throw error;
}

type SampleFileInfo = {
  tree: {
    path: string;
    type: string;
  }[];
  sha: string;
};

export async function getSampleFileInfo(
  urlInfo: SampleUrlInfo,
  retryLimits: number
): Promise<any> {
  const fileInfoUrl = `https://api.github.com/repos/${urlInfo.owner}/${urlInfo.repository}/git/trees/${urlInfo.ref}?recursive=1`;
  const fileInfo = (
    await sendRequestWithRetry(async () => {
      return await axios.get(fileInfoUrl);
    }, retryLimits)
  ).data as SampleFileInfo;

  const samplePaths = fileInfo?.tree
    ?.filter(
      (node) => node.path.startsWith(`${urlInfo.dir}/`) && node.type !== "tree"
    )
    .map((node) => node.path);
  const fileUrlPrefix = `https://raw.githubusercontent.com/${urlInfo.owner}/${urlInfo.repository}/${fileInfo?.sha}/`;
  return { samplePaths, fileUrlPrefix };
}

export async function downloadSampleFiles(
  fileUrlPrefix: string,
  samplePaths: string[],
  dstPath: string,
  relativePath: string,
  retryLimits: number,
  concurrencyLimits: number
): Promise<void> {
  const downloadCallback = async (samplePath: string) => {
    const file = (await sendRequestWithRetry(async () => {
      return await axios.get(fileUrlPrefix + samplePath, {
        responseType: "arraybuffer",
      });
    }, retryLimits)) as unknown as any;
    const filePath = path.join(
      dstPath,
      path.relative(`${relativePath}/`, samplePath)
    );
    await fs.ensureFile(filePath);
    await fs.writeFile(filePath, Buffer.from(file.data));
  };
  await runWithLimitedConcurrency(
    samplePaths,
    downloadCallback,
    concurrencyLimits
  );
}

export async function buildFileTree(
  fileUrlPrefix: string,
  samplePaths: string[],
  dstPath: string,
  relativeFolderName: string,
  retryLimits: number,
  concurrencyLimits: number
): Promise<vscode.ChatResponseFileTree[]> {
  const root: vscode.ChatResponseFileTree = {
    name: relativeFolderName,
    children: [],
  };
  const downloadCallback = async (samplePath: string) => {
    const file = (await sendRequestWithRetry(async () => {
      return await axios.get(fileUrlPrefix + samplePath, {
        responseType: "arraybuffer",
      });
    }, retryLimits)) as unknown as any;
    const relativePath = path.relative(`${relativeFolderName}/`, samplePath);
    const filePath = path.join(dstPath, samplePath);
    fileTreeAdd(root, relativePath, filePath);
    await fs.ensureFile(filePath);
    await fs.writeFile(filePath, Buffer.from(file.data));
  };
  await runWithLimitedConcurrency(
    samplePaths,
    downloadCallback,
    concurrencyLimits
  );
  return root.children ?? [];
}

function fileTreeAdd(
  root: vscode.ChatResponseFileTree,
  relativePath: string,
  filePath: string
) {
  const filename = path.basename(relativePath);
  const folderName = path.dirname(relativePath);
  const segments =
    path.sep === "\\" ? folderName.split("\\") : folderName.split("/");
  let parent = root;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === ".") {
      continue;
    }
    let child = parent.children?.find((child) => child.name === segment);
    if (!child) {
      child = {
        name: segment,
        children: [],
      };
      parent.children?.push(child);
    }
    parent = child;
  }
  parent.children?.push({
    name: filename,
  });
}

export function detectExtensionInstalled(extensionId: string): boolean {
  const res = vscode.extensions.getExtension(extensionId);
  return res !== undefined;
}

export async function runWithLimitedConcurrency<T>(
  items: T[],
  callback: (arg: T) => any,
  concurrencyLimit: number
): Promise<void> {
  const queue: any[] = [];
  for (const item of items) {
    // fire the async function, add its promise to the queue, and remove
    // it from queue when complete
    const p = callback(item)
      .then((res: any) => {
        queue.splice(queue.indexOf(p), 1);
        return res;
      })
      .catch((err: any) => {
        throw err;
      });
    queue.push(p);
    // if max concurrent, wait for one to finish
    if (queue.length >= concurrencyLimit) {
      await Promise.race(queue);
    }
  }
  // wait for the rest of the calls to finish
  await Promise.all(queue);
}

export function getTeamsApps(
  folders?: readonly vscode.WorkspaceFolder[]
): string[] | undefined {
  const teamsApps = folders
    ?.map((folder) => folder.uri.fsPath)
    .filter((p) => isValidProjectV3(p));
  return teamsApps;
}

export const MetadataV3 = {
  projectVersion: "1.0.0",
  unSupprotVersion: "2.0.0",
  platformVersion: {
    vs: "17.5.x.x",
    vsc: "5.x.x",
    cli: "2.x.x",
    cli_help: "2.x.x",
  },
  configFile: "teamsapp.yml",
  localConfigFile: "teamsapp.local.yml",
  testToolConfigFile: "teamsapp.testtool.yml",
  defaultEnvironmentFolder: "env",
  envFilePrefix: ".env",
  secretFileSuffix: "user",
  projectId: "projectId",
  teamsManifestFolder: "appPackage",
  teamsManifestFileName: "manifest.json",
  aadManifestFileName: "aad.manifest.json",
  v3UpgradeWikiLink: "https://aka.ms/teams-toolkit-5.0-upgrade",
  secretFileComment:
    "# This file includes environment variables that will not be committed to git by default. You can set these environment variables in your CI/CD system for your project." +
    EOL,
  secretComment:
    "# Secrets. Keys prefixed with `SECRET_` will be masked in Teams Toolkit logs." +
    EOL,
  envFileDevComment:
    "# This file includes environment variables that will be committed to git by default." +
    EOL,
  envFileLocalComment:
    "# This file includes environment variables that can be committed to git. It's gitignored by default because it represents your local development environment." +
    EOL,
};

export function isValidProjectV3(workspacePath: string): boolean {
  const ymlFilePath = path.join(workspacePath, MetadataV3.configFile);
  const localYmlPath = path.join(workspacePath, MetadataV3.localConfigFile);
  if (fs.pathExistsSync(ymlFilePath) || fs.pathExistsSync(localYmlPath)) {
    return true;
  }
  return false;
}

export async function modifyFile(filePath: string, generatedCode: string, addinSummary?: string) {
  const tsfilePath = path.join(filePath, "src", "taskpane", "taskpane.ts");
  const htmlFilePath = path.join(filePath, "src", "taskpane", "taskpane.html");
  const tsFileUri = vscode.Uri.file(tsfilePath);
  const htmlFileUri = vscode.Uri.file(htmlFilePath);

  try {
    // Read the file
    const tsFileData = await vscode.workspace.fs.readFile(tsFileUri);
    let tsFileContent = tsFileData.toString();
    const htmlFileData = await vscode.workspace.fs.readFile(htmlFileUri);
    let htmlFileContent = htmlFileData.toString();

    // Modify the file content
    const runFunctionStart = tsFileContent.indexOf('export async function run()');
    const runFunctionEnd = tsFileContent.lastIndexOf('}');
    const runFunction = tsFileContent.slice(runFunctionStart, runFunctionEnd + 1);
    let modifiedTsContent = tsFileContent;
    if (runFunctionStart !== -1) {
      modifiedTsContent = tsFileContent.replace(runFunction, generatedCode);
    } else {
      modifiedTsContent = tsFileContent + generatedCode;
    }

    const ulStart = htmlFileContent.indexOf('<ul class="ms-List ms-welcome__features">');
    const ulEnd = htmlFileContent.indexOf('</ul>') + '</ul>'.length;
    const ulSection = htmlFileContent.slice(ulStart, ulEnd);
    let modifiedHtmlContent = htmlFileContent;
    if (ulStart !== -1) {
      const htmlIntroduction = `<p class="ms-font-l"> This is an add-in generated by Microsoft365 Agent in GitHub Copilot</p>`;
      modifiedHtmlContent = htmlFileContent.replace(ulSection, htmlIntroduction);
    }

    const runStart = modifiedHtmlContent.indexOf('<b>');
    const runEnd = modifiedHtmlContent.indexOf('</b>') + '</b>'.length;
    const runElement = modifiedHtmlContent.slice(runStart, runEnd);


    const functionRegex = /function (\w+)/g;
    const newFunctionNames = generatedCode.match(functionRegex)?.map(func => func.replace('function ', '')) ?? [];
    if (runStart !== -1) {
      modifiedHtmlContent = modifiedHtmlContent.replace(runElement, `<b>${newFunctionNames[0]}</b>`);
    }

    for (var newFunctionName of newFunctionNames) {
      const mapStartIndex = modifiedTsContent.indexOf(`document.getElementById("run").onclick = run`);
      const mapEndIndex = mapStartIndex + `document.getElementById("run").onclick = run`.length;
      const map = modifiedTsContent.slice(mapStartIndex, mapEndIndex);

      const buttonStartIndex = modifiedHtmlContent.indexOf('<div role="button" id="run"');
      const buttonEndIndex = modifiedHtmlContent.indexOf('</div>', buttonStartIndex) + '</div>'.length;
      const button = modifiedHtmlContent.slice(buttonStartIndex, buttonEndIndex);
      if (mapStartIndex !== -1) {
        modifiedTsContent = modifiedTsContent.replace(map, `document.getElementById("${newFunctionName}").onclick = ${newFunctionName}`);
      }
      // else {
      //   const lastOnClickStartIndex = modifiedTsContent.lastIndexOf('onclick');
      //   const lastOnClickEndIndex = modifiedTsContent.indexOf(';\n', lastOnClickStartIndex) + ';\n'.length;
      //   const before = modifiedTsContent.slice(0, lastOnClickEndIndex);
      //   const after = modifiedTsContent.slice(lastOnClickEndIndex);
      //   const newLine = `    document.getElementById("${newFunctionName}").onclick = ${newFunctionName};\n`;
      //   modifiedTsContent = before + newLine + after;
      // }

      const newButtonCodeBlock = `
      <div role="button" id="${newFunctionName}" class="ms-welcome__action ms-Button ms-Button--hero ms-font-xl">
          <span class="ms-Button-label">${newFunctionName}</span>
      </div>
      `
      if (buttonStartIndex !== -1) {
        modifiedHtmlContent = modifiedHtmlContent.replace(button, newButtonCodeBlock);
      }
      // else {
      //   const lastButtonStartIndex = modifiedHtmlContent.lastIndexOf('<div role="button"');
      //   const lastButtonEndIndex = modifiedHtmlContent.indexOf('</div>\n', lastButtonStartIndex) + + '</div>\n'.length;
      //   const before = modifiedHtmlContent.slice(0, lastButtonEndIndex);
      //   const after = modifiedHtmlContent.slice(lastButtonEndIndex);
      //   modifiedHtmlContent = before + newButtonCodeBlock + '\n' + after;
      // }
    }

    // Write the modified content back to the file
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(tsFileUri, encoder.encode(modifiedTsContent));
    await vscode.workspace.fs.writeFile(htmlFileUri, encoder.encode(modifiedHtmlContent));
  } catch (error) {
    console.error(`Failed to modify file: ${error}`);
  }
}