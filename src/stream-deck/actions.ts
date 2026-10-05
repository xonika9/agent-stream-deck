import streamDeck, { action, type DidReceiveSettingsEvent, type KeyDownEvent, type KeyUpEvent, type WillAppearEvent, type WillDisappearEvent, SingletonAction } from "@elgato/streamdeck";
import type { DeckController, FixedIconSource } from "./controller.js";
import type { OfficialKeycapId } from "#codex";
import type { MicroActionSlot, MicroDirection, ReasoningAdjustment } from "#agents";
import { parseUsageLimitMode } from "#usage";

abstract class AgentAction extends SingletonAction {
  constructor(private readonly controller: DeckController, private readonly slot: number) { super(); }

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isKey()) this.controller.registerAgent(this.slot, ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.controller.unregisterAgent(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try { await this.controller.sendAgent(this.slot, 1, ev.action); }
    catch (error) {
      streamDeck.logger.error(`Agent key ${this.slot + 1} failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    try { await this.controller.sendAgent(this.slot, 0, ev.action); }
    catch (error) {
      streamDeck.logger.error(`Agent key ${this.slot + 1} failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }
}

@action({ UUID: "com.xonika9.codex-deck.agent-1" }) export class Agent1 extends AgentAction { constructor(c: DeckController) { super(c, 0); } }
@action({ UUID: "com.xonika9.codex-deck.agent-2" }) export class Agent2 extends AgentAction { constructor(c: DeckController) { super(c, 1); } }
@action({ UUID: "com.xonika9.codex-deck.agent-3" }) export class Agent3 extends AgentAction { constructor(c: DeckController) { super(c, 2); } }
@action({ UUID: "com.xonika9.codex-deck.agent-4" }) export class Agent4 extends AgentAction { constructor(c: DeckController) { super(c, 3); } }
@action({ UUID: "com.xonika9.codex-deck.agent-5" }) export class Agent5 extends AgentAction { constructor(c: DeckController) { super(c, 4); } }
@action({ UUID: "com.xonika9.codex-deck.agent-6" }) export class Agent6 extends AgentAction { constructor(c: DeckController) { super(c, 5); } }

abstract class MicroKeyAction extends SingletonAction {
  constructor(private readonly controller: DeckController, private readonly slot: MicroActionSlot) { super(); }

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isKey()) this.controller.registerMicroAction(this.slot, ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.controller.unregisterMicroAction(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try { await this.controller.sendMicroAction(this.slot, 1); }
    catch (error) {
      streamDeck.logger.error(`Micro action ${this.slot} failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    try { await this.controller.sendMicroAction(this.slot, 0); }
    catch (error) {
      streamDeck.logger.error(`Micro action ${this.slot} failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }
}

abstract class JoystickAction extends SingletonAction {
  constructor(
    private readonly controller: DeckController,
    private readonly direction: MicroDirection,
    private readonly icon: FixedIconSource
  ) { super(); }

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isKey()) this.controller.registerFixedAction(ev.action, this.icon);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.controller.unregisterFixedAction(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try { await this.controller.sendJoystick(this.direction, 1); }
    catch (error) {
      streamDeck.logger.error(`Joystick ${this.direction} failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    try { await this.controller.sendJoystick(this.direction, 0); }
    catch (error) {
      streamDeck.logger.error(`Joystick ${this.direction} failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }
}

class EncoderAction extends SingletonAction {
  constructor(private readonly controller: DeckController) { super(); }

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isKey()) this.controller.registerFixedAction(ev.action, { kind: "local", keycapId: "MIND-" });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.controller.unregisterFixedAction(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try { await this.controller.sendEncoder(1); }
    catch (error) {
      streamDeck.logger.error(`Reasoning encoder failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    try { await this.controller.sendEncoder(0); }
    catch (error) {
      streamDeck.logger.error(`Reasoning encoder failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }
}

abstract class ReasoningAdjustmentAction extends SingletonAction {
  private readonly holds = new Map<string, { timer?: NodeJS.Timeout }>();

  constructor(private readonly controller: DeckController, private readonly direction: ReasoningAdjustment) { super(); }

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isKey()) {
      this.controller.registerFixedAction(ev.action, {
        kind: "local", keycapId: this.direction === "increase" ? "MIND+" : "MIND-"
      });
    }
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (this.holds.has(ev.action.id)) return;
    const hold = {};
    this.holds.set(ev.action.id, hold);
    await this.repeat(ev, hold, 500);
  }

  override onKeyUp(ev: KeyUpEvent): void { this.stop(ev.action.id); }
  override onWillDisappear(ev: WillDisappearEvent): void {
    this.stop(ev.action.id);
    this.controller.unregisterFixedAction(ev.action);
  }

  private async repeat(ev: KeyDownEvent, hold: { timer?: NodeJS.Timeout }, delay: number): Promise<void> {
    if (this.holds.get(ev.action.id) !== hold) return;
    try { await this.controller.adjustReasoning(this.direction); }
    catch (error) {
      if (this.holds.get(ev.action.id) !== hold) return;
      this.stop(ev.action.id);
      streamDeck.logger.error(`Reasoning ${this.direction} failed: ${String(error)}`);
      await ev.action.showAlert();
      return;
    }
    if (this.holds.get(ev.action.id) === hold) {
      hold.timer = setTimeout(() => void this.repeat(ev, hold, 300), delay);
    }
  }

  private stop(id: string): void {
    const hold = this.holds.get(id);
    if (hold?.timer) clearTimeout(hold.timer);
    this.holds.delete(id);
  }
}

abstract class DirectKeycapAction extends SingletonAction {
  constructor(private readonly controller: DeckController, private readonly keycapId: OfficialKeycapId) { super(); }

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isKey()) this.controller.registerFixedAction(ev.action, { kind: "local", keycapId: this.keycapId });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.controller.unregisterFixedAction(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try { await this.controller.runKeycap(this.keycapId); }
    catch (error) {
      streamDeck.logger.error(`Keycap ${this.keycapId} failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }
}

@action({ UUID: "com.xonika9.codex-deck.fast" }) export class Fast extends MicroKeyAction { constructor(c: DeckController) { super(c, "ACT06"); } }
@action({ UUID: "com.xonika9.codex-deck.approve" }) export class Approve extends MicroKeyAction { constructor(c: DeckController) { super(c, "ACT07"); } }
@action({ UUID: "com.xonika9.codex-deck.decline" }) export class Decline extends MicroKeyAction { constructor(c: DeckController) { super(c, "ACT08"); } }
@action({ UUID: "com.xonika9.codex-deck.fork" }) export class Fork extends MicroKeyAction { constructor(c: DeckController) { super(c, "ACT09"); } }
@action({ UUID: "com.xonika9.codex-deck.dictation" }) export class Dictation extends MicroKeyAction { constructor(c: DeckController) { super(c, "ACT10_ACT11"); } }
@action({ UUID: "com.xonika9.codex-deck.send" }) export class Send extends MicroKeyAction { constructor(c: DeckController) { super(c, "ACT12"); } }
@action({ UUID: "com.xonika9.codex-deck.plan" }) export class Plan extends JoystickAction { constructor(c: DeckController) { super(c, "up", { kind: "local", keycapId: "BRCH" }); } }
@action({ UUID: "com.xonika9.codex-deck.back" }) export class Back extends JoystickAction { constructor(c: DeckController) { super(c, "left", { kind: "builtin", name: "back" }); } }
@action({ UUID: "com.xonika9.codex-deck.forward" }) export class Forward extends JoystickAction { constructor(c: DeckController) { super(c, "right", { kind: "builtin", name: "forward" }); } }
@action({ UUID: "com.xonika9.codex-deck.sidebar" }) export class Sidebar extends JoystickAction { constructor(c: DeckController) { super(c, "down", { kind: "builtin", name: "sidebar" }); } }
@action({ UUID: "com.xonika9.codex-deck.reasoning" }) export class Reasoning extends EncoderAction {}
@action({ UUID: "com.xonika9.codex-deck.reasoning-down" }) export class ReasoningDown extends ReasoningAdjustmentAction { constructor(c: DeckController) { super(c, "decrease"); } }
@action({ UUID: "com.xonika9.codex-deck.reasoning-up" }) export class ReasoningUp extends ReasoningAdjustmentAction { constructor(c: DeckController) { super(c, "increase"); } }

@action({ UUID: "com.xonika9.codex-deck.keycap-fast" }) export class KeycapFast extends DirectKeycapAction { constructor(c: DeckController) { super(c, "FAST"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-approve" }) export class KeycapApprove extends DirectKeycapAction { constructor(c: DeckController) { super(c, "APPR"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-reject" }) export class KeycapReject extends DirectKeycapAction { constructor(c: DeckController) { super(c, "REJ"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-split" }) export class KeycapSplit extends DirectKeycapAction { constructor(c: DeckController) { super(c, "SPLIT"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-new-task" }) export class KeycapNewTask extends DirectKeycapAction { constructor(c: DeckController) { super(c, "NEW"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-reasoning-up" }) export class KeycapReasoningUp extends DirectKeycapAction { constructor(c: DeckController) { super(c, "MIND+"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-reasoning-down" }) export class KeycapReasoningDown extends DirectKeycapAction { constructor(c: DeckController) { super(c, "MIND-"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-codex" }) export class KeycapCodex extends DirectKeycapAction { constructor(c: DeckController) { super(c, "CODEX"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-bug" }) export class KeycapBug extends DirectKeycapAction { constructor(c: DeckController) { super(c, "BUG"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-openai-docs" }) export class KeycapOpenAiDocs extends DirectKeycapAction { constructor(c: DeckController) { super(c, "OAI"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-terminal" }) export class KeycapTerminal extends DirectKeycapAction { constructor(c: DeckController) { super(c, "TERM"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-download" }) export class KeycapDownload extends DirectKeycapAction { constructor(c: DeckController) { super(c, "DWN"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-archive" }) export class KeycapArchive extends DirectKeycapAction { constructor(c: DeckController) { super(c, "DEL"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-browser" }) export class KeycapBrowser extends DirectKeycapAction { constructor(c: DeckController) { super(c, "NAV"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-pin" }) export class KeycapPin extends DirectKeycapAction { constructor(c: DeckController) { super(c, "MAGIC"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-diff" }) export class KeycapDiff extends DirectKeycapAction { constructor(c: DeckController) { super(c, "DIFF"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-play" }) export class KeycapPlay extends DirectKeycapAction { constructor(c: DeckController) { super(c, "PLAY"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-git-commit" }) export class KeycapGitCommit extends DirectKeycapAction { constructor(c: DeckController) { super(c, "GIT"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-branch" }) export class KeycapBranch extends DirectKeycapAction { constructor(c: DeckController) { super(c, "BRCH"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-merge" }) export class KeycapMerge extends DirectKeycapAction { constructor(c: DeckController) { super(c, "MRG"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-pull-request" }) export class KeycapPullRequest extends DirectKeycapAction { constructor(c: DeckController) { super(c, "PR"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-add-photos" }) export class KeycapAddPhotos extends DirectKeycapAction { constructor(c: DeckController) { super(c, "PAINT"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-lab" }) export class KeycapLab extends DirectKeycapAction { constructor(c: DeckController) { super(c, "LAB"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-side-chat" }) export class KeycapSideChat extends DirectKeycapAction { constructor(c: DeckController) { super(c, "PARTY"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-tasks" }) export class KeycapTasks extends DirectKeycapAction { constructor(c: DeckController) { super(c, "TIME"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-settings" }) export class KeycapSettings extends DirectKeycapAction { constructor(c: DeckController) { super(c, "SETUP"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-open-folder" }) export class KeycapOpenFolder extends DirectKeycapAction { constructor(c: DeckController) { super(c, "FOLD"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-add-files" }) export class KeycapAddFiles extends DirectKeycapAction { constructor(c: DeckController) { super(c, "UPL"); } }
@action({ UUID: "com.xonika9.codex-deck.keycap-skills" }) export class KeycapSkills extends DirectKeycapAction { constructor(c: DeckController) { super(c, "APPS"); } }

@action({ UUID: "com.xonika9.codex-deck.new-task" })
export class NewTask extends SingletonAction {
  constructor(private readonly controller: DeckController) { super(); }

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isKey()) this.controller.registerFixedAction(ev.action, { kind: "local", keycapId: "NEW" });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.controller.unregisterFixedAction(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try { await this.controller.createTask(); }
    catch (error) {
      streamDeck.logger.error(`New task failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }
}

@action({ UUID: "com.xonika9.codex-deck.host-toggle" })
export class HostToggle extends SingletonAction {
  constructor(private readonly controller: DeckController) { super(); }

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isKey()) this.controller.registerHostToggle(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.controller.unregisterHostToggle(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try { await this.controller.toggleTargetHost(); }
    catch (error) {
      streamDeck.logger.error(`Host toggle failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }
}

type UsageLimitSettings = { mode?: string };

@action({ UUID: "com.xonika9.codex-deck.usage-limit" })
export class UsageLimit extends SingletonAction<UsageLimitSettings> {
  constructor(private readonly controller: DeckController) { super(); }

  override onWillAppear(ev: WillAppearEvent<UsageLimitSettings>): void {
    if (ev.action.isKey()) this.controller.registerUsageLimit(ev.action, parseUsageLimitMode(ev.payload.settings.mode));
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<UsageLimitSettings>): void {
    if (ev.action.isKey()) this.controller.updateUsageLimitMode(ev.action, parseUsageLimitMode(ev.payload.settings.mode));
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.controller.unregisterUsageLimit(ev.action);
  }
}

@action({ UUID: "com.xonika9.codex-deck.usage-overview" })
export class UsageOverview extends SingletonAction {
  constructor(private readonly controller: DeckController) { super(); }

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isKey()) this.controller.registerUsageOverview(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.controller.unregisterUsageOverview(ev.action);
  }
}

@action({ UUID: "com.xonika9.codex-deck.rate-limit-reset" })
export class RateLimitReset extends SingletonAction {
  constructor(private readonly controller: DeckController) { super(); }

  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isKey()) this.controller.registerRateLimitReset(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.controller.unregisterRateLimitReset(ev.action);
  }

  override onKeyDown(ev: KeyDownEvent): void {
    this.controller.beginRateLimitReset(ev.action);
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    try {
      if (await this.controller.finishRateLimitReset(ev.action) && ev.action.isKey()) await ev.action.showOk();
    } catch (error) {
      streamDeck.logger.error(`Rate-limit reset failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }
}
