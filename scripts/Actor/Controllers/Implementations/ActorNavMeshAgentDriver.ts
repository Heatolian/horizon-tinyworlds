/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// Actor Framework Scripts v40

import {
  type Entity,
  NavMeshAgentComponent,
  NetworkingService,
  ActorMoveParams,
  Vec3,
} from 'meta/worlds';

import {
  NAV_MESH_LINK_AREA_JUMP,
  planLinkJump,
  planLinkWalk,
  sampleLinkTrajectory,
  type NavMeshLinkTrajectory,
} from '../../Utilities/NavMeshLinkTrajectory';

const COMMAND_LEASE_TICKS = 2;
const DESTINATION_REFRESH_SECONDS = 1;
/** Seconds past both crossings to wait for the crowd's link exit before resuming anyway. */
const LINK_EXIT_GRACE_SECONDS = 0.5;

/** A crowd steering sample, distinguished locally without changing the Worlds SDK. */
export class ActorNavMeshMoveParams extends ActorMoveParams {
  constructor(position: Vec3 | null, speed: number) {
    super(position, speed, null);
  }
}

function sameVector(a: Vec3 | null, b: Vec3): boolean {
  return a != null && a.x === b.x && a.y === b.y && a.z === b.z;
}

function finiteVector(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Shared by the actor's behaviors and its movement adapter. */
export class ActorNavMeshAgentDriver {
  private static readonly drivers = new WeakMap<Entity, ActorNavMeshAgentDriver>();

  static forEntity(entity: Entity): ActorNavMeshAgentDriver {
    let driver = this.drivers.get(entity);
    if (driver == null) {
      driver = new ActorNavMeshAgentDriver(entity);
      this.drivers.set(entity, driver);
    }
    return driver;
  }

  private constructor(private readonly entity: Entity) {}

  private requester: object | null = null;
  private publisher: object | null = null;
  private ticksSinceCommand = COMMAND_LEASE_TICKS + 1;
  private secondsSinceDestination = 0;
  private previousPosition: Vec3 | null = null;
  private feedbackPosition: Vec3 | null = null;
  private feedbackVelocity: Vec3 | null = null;
  private recommendedPosition: Vec3 | null = null;
  private recommendedVelocity: Vec3 = Vec3.zero;
  private link: NavMeshLinkTrajectory | null = null;
  private linkElapsed = 0;
  private linkDeadline = 0;
  private linkExited = false;
  private linkJumpRequester: object | null = null;

  get agent(): NavMeshAgentComponent | null {
    if (!this.entity.valid || !this.entity.isOwned()) {
      return null;
    }
    const agent = this.entity.getComponent(NavMeshAgentComponent);
    return agent != null && NetworkingService.get().isServerContext() ? agent : null;
  }

  /** Called every movement-adapter tick, including ticks with no movement command. */
  update(deltaTime: number, position: Vec3): void {
    const agent = this.agent;
    if (agent == null || !finiteVector(position)) {
      return;
    }
    this.ticksSinceCommand++;
    if (Number.isFinite(deltaTime) && deltaTime > 0) {
      this.secondsSinceDestination += deltaTime;
    }
    const velocity =
      this.previousPosition != null && Number.isFinite(deltaTime) && deltaTime > 0
        ? position.sub(this.previousPosition).div(deltaTime)
        : Vec3.zero;
    this.previousPosition = position;

    if (this.link != null) {
      this.updateLink(agent, this.link, deltaTime, position);
      return;
    }

    const expectedPosition = this.recommendedPosition;
    const outputPosition = agent.avoidancePosition;
    const outputVelocity = agent.avoidanceVelocity;
    const fresh =
      this.feedbackPosition != null &&
      (!sameVector(this.feedbackPosition, outputPosition) ||
        !sameVector(this.feedbackVelocity, outputVelocity));
    this.recommendedPosition = position;
    this.recommendedVelocity = Vec3.zero;
    if (
      this.requester != null &&
      fresh &&
      finiteVector(outputPosition) &&
      finiteVector(outputVelocity)
    ) {
      this.recommendedPosition = outputPosition;
      this.recommendedVelocity = outputVelocity;
    }

    if (this.ticksSinceCommand > COMMAND_LEASE_TICKS) {
      this.stop(position);
    }
    // Native sync consumes corrections before publishing the completed job.
    // Do not continuously feed corrections (which would erase every result),
    // and wait for a new result before sending another active correction.
    const displaced = expectedPosition != null &&
      position.sub(expectedPosition).magnitude() > agent.agentRadius;
    if (this.requester == null || (fresh && displaced)) {
      this.recommendedPosition = position;
      this.recommendedVelocity = Vec3.zero;
      agent.avoidancePosition = position;
      agent.avoidanceVelocity = velocity;
      this.feedbackPosition = position;
      this.feedbackVelocity = velocity;
    }
  }

  /** Where the body must be this tick while crossing a link; null when not crossing one. */
  get linkTarget(): Vec3 | null {
    return this.link != null ? sampleLinkTrajectory(this.link, this.linkElapsed) : null;
  }

  /**
   * `OnNavMeshLinkEnterEvent`: the crowd moved the agent onto a link. Only a body some behavior
   * is steering crosses; an idle one keeps reporting where it stands.
   */
  enterLink(areaType: number, start: Vec3, end: Vec3, body: {position: Vec3; originOffset?: number}): void {
    const {position, originOffset: bodyOriginOffset = 0} = body;
    const agent = this.agent;
    if (this.link != null || agent == null || this.requester == null ||
      !finiteVector(start) || !finiteVector(end) || !finiteVector(position) || !Number.isFinite(bodyOriginOffset)) {
      return;
    }
    const landing = new Vec3(end.x, end.y + bodyOriginOffset, end.z);
    const speed = agent.maxSpeed;
    const jump = areaType === NAV_MESH_LINK_AREA_JUMP;
    this.link = jump ? planLinkJump(position, landing) : planLinkWalk(position, landing, speed);
    this.linkElapsed = 0;
    this.linkExited = false;
    this.linkJumpRequester = jump ? this.requester : null;
    // DetourCrowd's own off-mesh animation time.
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const crowdDuration = speed > 0 ? (Math.sqrt(dx * dx + dz * dz) / speed) * 0.5 : 0;
    this.linkDeadline = Math.max(this.link.duration, crowdDuration) + LINK_EXIT_GRACE_SECONDS;
    // The crowd finishes its own crossing first; parked, it waits at the link end.
    agent.maxSpeed = 0;
    // Park the target too: DetourCrowd still follows a parked agent's path and would enter an
    // adjacent link with tmax = distance / 0, which never elapses. The resync restores it.
    agent.destination = end;
  }

  /** `OnNavMeshLinkExitEvent`: the crowd agent is walking again past the link end. */
  exitLink(): void {
    if (this.link != null) {
      this.linkExited = true;
    }
  }

  /** True once per jump link, for the behavior steering the agent to forward to `IActorJump`. */
  takeLinkJump(requester: object): boolean {
    if (this.link == null || this.linkJumpRequester !== requester) {
      return false;
    }
    this.linkJumpRequester = null;
    return true;
  }

  private updateLink(
    agent: NavMeshAgentComponent,
    link: NavMeshLinkTrajectory,
    deltaTime: number,
    position: Vec3,
  ): void {
    this.recommendedPosition = position;
    this.recommendedVelocity = Vec3.zero;
    // The body was put on the end last tick; finish once the crowd is off the link too.
    if (this.linkElapsed < link.duration ||
      (!this.linkExited && this.linkElapsed < this.linkDeadline)) {
      if (Number.isFinite(deltaTime) && deltaTime > 0) {
        this.linkElapsed += deltaTime;
      }
      return;
    }
    // Resync the agent to the landed body and resume.
    this.link = null;
    this.linkJumpRequester = null;
    agent.avoidancePosition = position;
    agent.avoidanceVelocity = Vec3.zero;
    this.feedbackPosition = position;
    this.feedbackVelocity = Vec3.zero;
    this.secondsSinceDestination = DESTINATION_REFRESH_SECONDS;
    if (this.ticksSinceCommand > COMMAND_LEASE_TICKS) {
      this.stop(position);
    }
  }

  get shouldHoldSteering(): boolean {
    return this.requester == null || this.recommendedVelocity.magnitudeSquared() === 0;
  }

  /** Only a behavior that won the movement axis may publish an intent. */
  move(requester: object, target: Vec3, speed: number, position: Vec3): ActorMoveParams {
    const agent = this.agent;
    const maxSpeed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
    if (agent == null || !finiteVector(target)) {
      return new ActorNavMeshMoveParams(null, 0);
    }
    if (this.link != null) {
      // The body follows the link trajectory; the agent stays parked until it lands.
      this.publisher = requester;
      this.requester = requester;
      this.ticksSinceCommand = 0;
      return new ActorNavMeshMoveParams(position, 0);
    }
    const firstCommand = this.publisher !== requester;
    const activated = firstCommand || (maxSpeed > 0 && this.requester == null);
    if (activated || maxSpeed === 0) {
      this.recommendedPosition = position;
      this.recommendedVelocity = Vec3.zero;
      agent.avoidancePosition = position;
      agent.avoidanceVelocity = Vec3.zero;
      this.feedbackPosition = position;
      this.feedbackVelocity = Vec3.zero;
    }
    this.publisher = requester;
    this.requester = maxSpeed > 0 ? requester : null;
    this.ticksSinceCommand = 0;
    if (activated || this.secondsSinceDestination >= DESTINATION_REFRESH_SECONDS ||
      !sameVector(agent.destination, target)) {
      agent.destination = target;
      this.secondsSinceDestination = 0;
    }
    if (agent.maxSpeed !== maxSpeed) {
      agent.maxSpeed = maxSpeed;
    }
    return new ActorNavMeshMoveParams(
      this.recommendedPosition ?? position,
      Math.min(maxSpeed, this.recommendedVelocity.magnitude()),
    );
  }

  getTravelDirection(requester: object): Vec3 | null {
    const velocity = this.link != null ? this.link.end.sub(this.link.start) : this.recommendedVelocity;
    const magnitude = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    return this.requester === requester && magnitude > 1e-4
      ? new Vec3(velocity.x / magnitude, 0, velocity.z / magnitude)
      : null;
  }

  stop(position: Vec3): void {
    this.link = null;
    this.linkJumpRequester = null;
    const agent = this.agent;
    if (agent == null) {
      return;
    }
    this.requester = null;
    this.publisher = null;
    this.recommendedPosition = position;
    this.recommendedVelocity = Vec3.zero;
    if (agent.maxSpeed !== 0) {
      agent.maxSpeed = 0;
    }
    if (!sameVector(agent.destination, position)) {
      agent.destination = position;
    }
  }
}
