const scope = globalThis as typeof globalThis & { pageLingoContentLoaded?: boolean };

if (!scope.pageLingoContentLoaded) {
  scope.pageLingoContentLoaded = true;
  void import("./content").catch((error) => {
    scope.pageLingoContentLoaded = false;
    console.error("[PageLingo] Content initialization failed", error);
  });
}
