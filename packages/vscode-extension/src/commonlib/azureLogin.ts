// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
/* eslint-disable @typescript-eslint/no-empty-function */

/* eslint-disable @typescript-eslint/no-empty-function */

"use strict";

import type { TokenCredential } from "@azure/core-auth";
import {
  AzureAccountProvider,
  UserError,
  SubscriptionInfo,
  SingleSelectConfig,
  OptionItem,
  SystemError,
} from "@microsoft/teamsfx-api";
import { ExtensionErrors } from "../error";
import { ConvertTokenToJson, LoginFailureError } from "./codeFlowLogin";
import * as vscode from "vscode";
import {
  initializing,
  loggedIn,
  loggedOut,
  loggingIn,
  signedIn,
  signedOut,
  signingIn,
} from "./common/constant";
import { login, LoginStatus } from "./common/login";
import * as util from "util";
import { ExtTelemetry } from "../telemetry/extTelemetry";
import VsCodeLogInstance from "./log";
import {
  TelemetryEvent,
  TelemetryProperty,
  TelemetrySuccess,
  AccountType,
  TelemetryErrorType,
} from "../telemetry/extTelemetryEvents";
import { VS_CODE_UI } from "../extension";
import { AzureScopes } from "@microsoft/teamsfx-core";
import { getDefaultString, localize } from "../utils/localizeUtils";
import { TokenCredentialsBase } from "@azure/ms-rest-nodeauth";
import type { AccessToken, GetTokenOptions } from "@azure/identity";
import { subscriptionProviderFactory } from "../globalVariables";
import { AzureSubscriptionProvider } from "@microsoft/vscode-azext-azureauth";

class TeamsFxTokenCredential implements TokenCredential {
  private tokenCredentialBase: TokenCredentialsBase;

  constructor(tokenCredentialBase: TokenCredentialsBase) {
    this.tokenCredentialBase = tokenCredentialBase;
  }

  async getToken(
    scopes: string | string[],
    options?: GetTokenOptions | undefined
  ): Promise<AccessToken | null> {
    try {
      if (this.tokenCredentialBase) {
        const token = await this.tokenCredentialBase.getToken();
        const tokenJson = ConvertTokenToJson(token.accessToken);
        return {
          token: token.accessToken,
          expiresOnTimestamp: (tokenJson as any).exp * 1000,
        };
      } else {
        return null;
      }
    } catch (error) {
      if (error.message === "Entry not found in cache.") {
        throw new SystemError(
          "Login",
          ExtensionErrors.LoginCacheError,
          localize("teamstoolkit.handlers.loginCacheFailed")
        );
      }
      throw error;
    }
  }
}

export class AzureAccountManager extends login implements AzureAccountProvider {
  private static instance: AzureAccountManager;
  private static subscriptionId: string | undefined;
  private static subscriptionName: string | undefined;
  private static tenantId: string | undefined;
  private static currentStatus: string | undefined;
  private static provider: AzureSubscriptionProvider;

  private static statusChange?: (
    status: string,
    token?: string,
    accountInfo?: Record<string, unknown>
  ) => Promise<void>;

  private constructor() {
    super();
    void this.addStatusChangeEvent();
  }

  /**
   * Gets instance
   * @returns instance
   */
  public static getInstance(): AzureAccountManager {
    if (!AzureAccountManager.instance) {
      AzureAccountManager.instance = new AzureAccountManager();
    }

    return AzureAccountManager.instance;
  }

  /**
   * Async get identity [crendential](https://github.com/Azure/azure-sdk-for-js/blob/master/sdk/core/core-auth/src/tokenCredential.ts)
   */
  async getIdentityCredentialAsync(showDialog = true): Promise<TokenCredential | undefined> {
    if (await this.isUserLogin()) {
      return this.doGetIdentityCredentialAsync();
    }
    await this.login(showDialog);
    return this.doGetIdentityCredentialAsync();
  }

  private async updateLoginStatus(): Promise<void> {
    if ((await this.isUserLogin()) && AzureAccountManager.statusChange !== undefined) {
      const credential = await this.getIdentityCredentialAsync();
      const accessToken = await credential?.getToken(AzureScopes);
      const accountJson = await this.getJsonObject();
      await AzureAccountManager.statusChange("SignedIn", accessToken?.token, accountJson);
    }
  }

  private async isUserLogin(): Promise<boolean> {
    if (AzureAccountManager.provider == undefined) {
      void this.addStatusChangeEvent();
    }
    if (AzureAccountManager.provider != undefined) {
      return await AzureAccountManager.provider.isSignedIn();
    } else {
      return false;
    }
  }

  private async login(showDialog: boolean): Promise<void> {
    if (showDialog) {
      const userConfirmation: boolean = await this.doesUserConfirmLogin();
      if (!userConfirmation) {
        // throw user cancel error
        throw new UserError(
          "Login",
          ExtensionErrors.UserCancel,
          getDefaultString("teamstoolkit.common.userCancel"),
          localize("teamstoolkit.common.userCancel")
        );
      }
    }

    ExtTelemetry.sendTelemetryEvent(TelemetryEvent.LoginStart, {
      [TelemetryProperty.AccountType]: AccountType.Azure,
    });
    await AzureAccountManager.provider.signIn();
    if (!(await this.isUserLogin())) {
      throw new UserError(
        getDefaultString("teamstoolkit.codeFlowLogin.loginComponent"),
        getDefaultString("teamstoolkit.codeFlowLogin.loginTimeoutTitle"),
        getDefaultString("teamstoolkit.codeFlowLogin.loginTimeoutDescription"),
        localize("teamstoolkit.codeFlowLogin.loginTimeoutDescription")
      );
    }
  }

  private async doGetIdentityCredentialAsync(): Promise<TokenCredential | undefined> {
    const credential = await this.doGetAccountCredentialAsync();
    if (credential) {
      return credential;
    } else {
      return Promise.reject(LoginFailureError());
    }
  }

  private async doGetAccountCredentialAsync(): Promise<TokenCredential | undefined> {
    if (await this.isUserLogin()) {
      const subs = await AzureAccountManager.provider.getSubscriptions(false);
      if (subs.length > 0) {
        return subs[0].credential;
      } else {
        throw LoginFailureError();
      }

      // Choose one tenant credential when users have multi tenants. (TODO, need to optize after UX design)
      // 1. When azure-account-extension has at least one subscription, return the first one credential.
      // 2. When azure-account-extension has no subscription and has at at least one session, return the first session credential.
      // 3. When azure-account-extension has no subscription and no session, return undefined.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises

      // return new Promise(async (resolve, reject) => {
      //   await azureAccount.waitForSubscriptions();
      //   if (azureAccount.subscriptions.length > 0) {
      //     let credential2 = azureAccount.subscriptions[0].session.credentials2;
      //     if (AzureAccountManager.tenantId) {
      //       for (let i = 0; i < azureAccount.sessions.length; ++i) {
      //         const item = azureAccount.sessions[i];
      //         if (item.tenantId == AzureAccountManager.tenantId) {
      //           credential2 = item.credentials2;
      //           break;
      //         }
      //       }
      //     }
      //     // TODO - If the correct process is always selecting subs before other calls, throw error if selected subs not exist.
      //     resolve(credential2);
      //   } else if (azureAccount.sessions.length > 0) {
      //     resolve(azureAccount.sessions[0].credentials2);
      //   } else {
      //     reject(LoginFailureError());
      //   }
      // });
    }
    throw LoginFailureError();
  }

  private async doesUserConfirmLogin(): Promise<boolean> {
    const message = localize("teamstoolkit.azureLogin.message");
    const signin = localize("teamstoolkit.common.signin");
    const readMore = localize("teamstoolkit.common.readMore");
    let userSelected: string | undefined;
    do {
      userSelected = await vscode.window.showInformationMessage(
        message,
        { modal: true },
        signin,
        readMore
      );
      if (userSelected === readMore) {
        void vscode.env.openExternal(
          vscode.Uri.parse(
            "https://docs.microsoft.com/en-us/azure/cost-management-billing/manage/create-subscription"
          )
        );
      }
    } while (userSelected === readMore);

    return Promise.resolve(userSelected === signin);
  }

  private async doesUserConfirmSignout(): Promise<boolean> {
    const accountInfo = (await this.getStatus()).accountInfo;
    const email = (accountInfo as any).upn ? (accountInfo as any).upn : (accountInfo as any).email;
    const confirm = localize("teamstoolkit.common.signout");
    const userSelected: string | undefined = await vscode.window.showInformationMessage(
      util.format(localize("teamstoolkit.common.signOutOf"), email),
      { modal: true },
      confirm
    );
    return Promise.resolve(userSelected === confirm);
  }

  async getJsonObject(showDialog = true): Promise<Record<string, unknown> | undefined> {
    const credential = await this.getIdentityCredentialAsync(showDialog);
    const token = await credential?.getToken("https://management.core.windows.net/.default");
    if (token) {
      const array = token.token.split(".");
      const buff = Buffer.from(array[1], "base64");
      return new Promise((resolve) => {
        resolve(JSON.parse(buff.toString("utf-8")));
      });
    } else {
      return new Promise((resolve) => {
        resolve(undefined);
      });
    }
  }

  /**
   * signout from Azure
   */
  async signout(): Promise<boolean> {
    const userConfirmation: boolean = await this.doesUserConfirmSignout();
    if (!userConfirmation) {
      // throw user cancel error
      throw new UserError(
        "SignOut",
        ExtensionErrors.UserCancel,
        getDefaultString("teamstoolkit.common.userCancel"),
        localize("teamstoolkit.common.userCancel")
      );
    }
    try {
      await AzureAccountManager.provider.signOut();
      AzureAccountManager.tenantId = undefined;
      AzureAccountManager.subscriptionId = undefined;
      ExtTelemetry.sendTelemetryEvent(TelemetryEvent.SignOut, {
        [TelemetryProperty.AccountType]: AccountType.Azure,
        [TelemetryProperty.Success]: TelemetrySuccess.Yes,
      });
      return new Promise((resolve) => {
        resolve(true);
      });
    } catch (e) {
      VsCodeLogInstance.error("[Logout Azure] " + (e.message as string));
      ExtTelemetry.sendTelemetryErrorEvent(TelemetryEvent.SignOut, e, {
        [TelemetryProperty.AccountType]: AccountType.Azure,
        [TelemetryProperty.Success]: TelemetrySuccess.No,
        [TelemetryProperty.ErrorType]:
          e instanceof UserError ? TelemetryErrorType.UserError : TelemetryErrorType.SystemError,
        [TelemetryProperty.ErrorCode]: `${e.source as string}.${e.name as string}`,
        [TelemetryProperty.ErrorMessage]: `${e.message as string}`,
      });
      return Promise.resolve(false);
    }
  }

  /**
   * list all subscriptions
   */
  async listSubscriptions(): Promise<SubscriptionInfo[]> {
    await this.getIdentityCredentialAsync();
    const arr: SubscriptionInfo[] = [];
    if (await this.isUserLogin()) {
      const subs = await AzureAccountManager.provider.getSubscriptions(false);
      if (subs.length > 0) {
        for (let i = 0; i < subs.length; ++i) {
          const item = subs[i];
          arr.push({
            subscriptionId: item.subscriptionId,
            subscriptionName: item.name,
            tenantId: item.tenantId,
          });
        }
      }
    }
    return arr;
  }

  /**
   * set tenantId and subscriptionId
   */
  async setSubscription(subscriptionId: string): Promise<void> {
    if (subscriptionId === "") {
      AzureAccountManager.tenantId = undefined;
      AzureAccountManager.subscriptionId = undefined;
      AzureAccountManager.subscriptionName = undefined;
      return Promise.resolve();
    }
    if (await this.isUserLogin()) {
      const subs = await AzureAccountManager.provider.getSubscriptions(false);
      for (let i = 0; i < subs.length; ++i) {
        const item = subs[i];
        if (item.subscriptionId == subscriptionId) {
          AzureAccountManager.tenantId = item.tenantId;
          AzureAccountManager.subscriptionId = subscriptionId;
          AzureAccountManager.subscriptionName = item.name;
          return Promise.resolve();
        }
      }
    }
    return Promise.reject(
      new UserError(
        "Login",
        ExtensionErrors.UnknownSubscription,
        getDefaultString("teamstoolkit.azureLogin.unknownSubscription"),
        localize("teamstoolkit.azureLogin.unknownSubscription")
      )
    );
  }

  async getStatus(): Promise<LoginStatus> {
    try {
      if (await this.isUserLogin()) {
        const credential = await this.doGetIdentityCredentialAsync();
        const token = await credential?.getToken("https://management.core.windows.net/.default");
        const accountJson = await this.getJsonObject();
        return Promise.resolve({
          status: signedIn,
          token: token?.token,
          accountInfo: accountJson,
        });
      } else {
        return Promise.resolve({ status: signedOut, token: undefined, accountInfo: undefined });
      }
    } catch (error) {
      console.log(error);
      throw error;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async addStatusChangeEvent() {
    if (AzureAccountManager.provider == undefined) {
      AzureAccountManager.provider = await subscriptionProviderFactory();
      if (AzureAccountManager.provider) {
        await this.updateLoginStatus();
        await this.notifyStatus();
      }
    }
    if (AzureAccountManager.provider) {
      AzureAccountManager.provider = await subscriptionProviderFactory();
      AzureAccountManager.provider.onDidSignIn(async () => {
        AzureAccountManager.currentStatus = loggedIn;
        await this.updateLoginStatus();
        await this.notifyStatus();
      });
      AzureAccountManager.provider.onDidSignOut(async () => {
        AzureAccountManager.currentStatus = loggedOut;
        if (AzureAccountManager.statusChange !== undefined) {
          await AzureAccountManager.statusChange(signedOut, undefined, undefined);
        }
        await this.notifyStatus();
      });
    }
    // const azureAccount: AzureAccount =
    //   vscode.extensions.getExtension<AzureAccount>("ms-vscode.azure-account")!.exports;
    // AzureAccountManager.currentStatus = azureAccount.status;
    // azureAccount.onStatusChanged(async (event: string | undefined) => {
    //   if (this.isLegacyVersion()) {
    //     if (AzureAccountManager.currentStatus === "Initializing") {
    //       AzureAccountManager.currentStatus = event;
    //       return;
    //     }
    //     AzureAccountManager.currentStatus = event;
    //     if (event === loggedOut) {
    //       if (AzureAccountManager.statusChange !== undefined) {
    //         await AzureAccountManager.statusChange(signedOut, undefined, undefined);
    //       }
    //       await this.notifyStatus();
    //     } else if (event === loggedIn) {
    //       await this.updateLoginStatus();
    //       await this.notifyStatus();
    //     } else if (event === loggingIn) {
    //       await this.notifyStatus();
    //     }
    //   } else {
    //     if (AzureAccountManager.currentStatus === initializing) {
    //       if (event === loggedIn) {
    //         AzureAccountManager.currentStatus = event;
    //       } else if (event === loggedOut) {
    //         AzureAccountManager.currentStatus = event;
    //       }
    //       return;
    //     }
    //     AzureAccountManager.currentStatus = event;
    //     if (event === loggedOut) {
    //       if (AzureAccountManager.statusChange !== undefined) {
    //         await AzureAccountManager.statusChange(signedOut, undefined, undefined);
    //       }
    //       await this.notifyStatus();
    //     } else if (event === loggedIn) {
    //       await this.updateLoginStatus();
    //       await this.notifyStatus();
    //     } else if (event === loggingIn) {
    //       await this.notifyStatus();
    //     }
    //   }
    // });
  }

  public async clearSub() {
    await this.setSubscription("");
  }

  getAccountInfo(): Record<string, string> | undefined {
    if (AzureAccountManager.currentStatus === loggedIn) {
      return this.getJsonObject() as unknown as Record<string, string>;
    } else {
      return undefined;
    }
  }

  async getSelectedSubscription(triggerUI = false): Promise<SubscriptionInfo | undefined> {
    if (triggerUI) {
      if (AzureAccountManager.currentStatus !== loggedIn) {
        await this.login(true);
      }
      if (AzureAccountManager.currentStatus === loggedIn && !AzureAccountManager.subscriptionId) {
        await this.selectSubscription();
      }
    } else {
      if (AzureAccountManager.currentStatus === loggedIn && !AzureAccountManager.subscriptionId) {
        const subscriptionList = await this.listSubscriptions();
        if (subscriptionList && subscriptionList.length == 1) {
          await this.setSubscription(subscriptionList[0].subscriptionId);
        }
      }
    }
    if (AzureAccountManager.currentStatus === loggedIn && AzureAccountManager.subscriptionId) {
      const selectedSub: SubscriptionInfo = {
        subscriptionId: AzureAccountManager.subscriptionId,
        tenantId: AzureAccountManager.tenantId!,
        subscriptionName: AzureAccountManager.subscriptionName ?? "",
      };
      return selectedSub;
    } else {
      return undefined;
    }
  }

  async selectSubscription(): Promise<void> {
    const subscriptionList = await this.listSubscriptions();
    if (!subscriptionList || subscriptionList.length == 0) {
      throw new UserError(
        getDefaultString("teamstoolkit.codeFlowLogin.loginComponent"),
        getDefaultString("teamstoolkit.azureLogin.noSubscriptionFound"),
        getDefaultString("teamstoolkit.azureLogin.failToFindSubscription"),
        localize("teamstoolkit.azureLogin.failToFindSubscription")
      );
    }
    if (subscriptionList && subscriptionList.length == 1) {
      await this.setSubscription(subscriptionList[0].subscriptionId);
    } else if (subscriptionList.length > 1) {
      const options: OptionItem[] = subscriptionList.map((sub) => {
        return {
          id: sub.subscriptionId,
          label: sub.subscriptionName,
          data: sub.tenantId,
        } as OptionItem;
      });
      const config: SingleSelectConfig = {
        name: localize("teamstoolkit.azureLogin.subscription"),
        title: localize("teamstoolkit.azureLogin.selectSubscription"),
        options: options,
      };
      const result = await VS_CODE_UI.selectOption(config);
      if (result.isErr()) {
        throw result.error;
      } else {
        const subId = result.value.result as string;
        await this.setSubscription(subId);
      }
    }
  }
}

export default AzureAccountManager.getInstance();
