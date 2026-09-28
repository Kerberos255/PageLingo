export type ExternalDataCollectionPermission = "websiteContent" | "authenticationInfo";

type FirefoxPermissionsWithDataCollection = browser.permissions.Permissions & {
  data_collection: ExternalDataCollectionPermission[];
};

function externalTranslationPermissionSpec(hasApiKey: boolean): FirefoxPermissionsWithDataCollection {
  return {
    data_collection: hasApiKey
      ? ["websiteContent", "authenticationInfo"]
      : ["websiteContent"],
  };
}

export async function hasExternalTranslationConsent(hasApiKey: boolean): Promise<boolean> {
  return browser.permissions.contains(externalTranslationPermissionSpec(hasApiKey));
}

export async function requestExternalTranslationConsent(hasApiKey: boolean): Promise<boolean> {
  return browser.permissions.request(externalTranslationPermissionSpec(hasApiKey));
}
