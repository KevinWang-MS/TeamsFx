/* eslint-disable @typescript-eslint/no-var-requires */
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// NOTE:
// DO NOT EDIT this file in function plugin.
// The source of truth of this file is in packages/vscode-extension/src/debug/depsChecker.
// If you need to edit this file, please edit it in the above folder
// and run the scripts (tools/depsChecker/copyfiles.sh or tools/depsChecker/copyfiles.ps1 according to your OS)
// to copy you changes to function plugin.
import { getLocalizedString } from "../../../common/localizeUtils";

export const Messages = {
  downloadBicep: () => getLocalizedString("depChecker.downloadBicep"),
  finishInstallBicep: () => getLocalizedString("depChecker.finishInstallBicep"),
};

export enum DepsCheckerEvent {
  // since FuncToolChecker is disabled and azure functions core tools will be installed as devDependencies now,
  // below events related to FuncToolChecker won't be displayed to end user.
  bicepCheckSkipped = "bicep-check-skipped",
  bicepAlreadyInstalled = "bicep-already-installed",
  bicepInstallCompleted = "bicep-install-completed",
  bicepInstallError = "bicep-install-error",
  bicepInstallScriptCompleted = "bicep-install-script-completed",
  bicepInstallScriptError = "bicep-install-script-error",
  bicepValidationError = "bicep-validation-error",
  bicepFailedToRetrieveGithubReleaseVersions = "bicep-failed-to-retrieve-github-release-versions",

  clickLearnMore = "env-checker-click-learn-more",
  clickCancel = "env-checker-click-cancel",
}

export enum TelemtryMessages {
  failedToInstallBicep = "failed to install Bicep.",
  failedToValidateBicep = "failed to validate Bicep.",
}

export enum TelemetryMeasurement {
  completionTime = "completion-time",
  OSArch = "os-arch",
  OSRelease = "os-release",
  Component = "component",
  ErrorMessage = "error-message",
}
