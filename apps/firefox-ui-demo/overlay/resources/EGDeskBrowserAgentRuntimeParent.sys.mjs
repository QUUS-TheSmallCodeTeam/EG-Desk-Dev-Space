export class EGDeskBrowserAgentRuntimeParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== "authorizeAct") throw new Error("Unsupported Browser actor parent message");
    const context = this.browsingContext || this.manager?.browsingContext;
    const browser = context?.top?.embedderElement || context?.embedderElement;
    const authorize = browser?.ownerGlobal?.__egdesk?.browserAgentTools?.authorizePhysicalAction;
    if (typeof authorize !== "function") return { authorized: false };
    try {
      return { authorized: authorize({ ...message.data, browser,
        browsingContext: context, windowGlobal: this.manager }) === true };
    } catch { return { authorized: false }; }
  }
}
