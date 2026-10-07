import * as Cesium from "cesium";

// =============================================================================
// Types
// =============================================================================

export interface RadarOptions {
    entityId: string;
    longitude: number;
    latitude: number;
    altitude?: number;
    mastHeight?: number;
    beam: BeamSettings;
    azimuthStepDeg?: number;
    showBlockedPoints?: boolean;
    style: RadarStyle;
}

// The one beam the radar sends out.
export interface BeamSettings {
    // Centre of the beam, degrees clockwise from north.
    azimuthDeg: number;
    // Horizontal width of the beam (360 = all round).
    widthDeg: number;
    range: number;
    minElevationDeg: number;
    maxElevationDeg: number;
    // Height above the terrain of the aircraft the blocking is worked out for
    // (0 = the ground itself).
    targetHeightAgl: number;
    // Antenna height above the ground it stands on.
    mastHeight: number;
    // Angular spacing used to build the beam mesh; larger values are coarser.
    wallDetailDeg: number;
    // Rays drawn: how many directions across the beam, and how many angles
    // from the min to the max angle in each direction.
    raysAcross: number;
    raysUp: number;
}

// Settings that only change how the coverage looks. Applied in place through
// RadarCoverageHandle.setStyle, without re-sampling terrain or rebuilding.
export interface RadarStyle {
    beamOpacity: number;
    showBeam: boolean;
    hitWallOpacity: number;
    // Ground footprint: green where the beam lands, dark where terrain blocks it.
    blockedOpacity: number;
    showBlocked: boolean;
    showRays: boolean;
}

export interface RadarCoverageHandle {
    dispose(): void;
    setStyle?(style: RadarStyle): void;
}

export interface ResolvedZone {
    name: string;
    color: Cesium.Color;
    range: number;
    minElevationDeg: number;
    maxElevationDeg: number;
    azimuthStartDeg: number;
    azimuthWidthDeg: number;
}

export interface RadarZoneConfig {
    name: string;
    cssColor: string;
    color: Cesium.Color;
}

// What a built radar needs to answer "can it see this point, and if not, why?".
// Kept per radar entity for the click-to-explain probe (see CesiumLosProbe).
export interface RadarGeometry {
    radarPosition: Cesium.Cartesian3;
    radarHeight: number;
    enuMatrix: Cesium.Matrix4;
    zones: ResolvedZone[];
    targetHeightAgl: number;
}

interface TerrainProfile {
    azimuthDeg: number;
    horizontalDistances: number[];
    groundHeights: number[];
    groundPoints: Cesium.Cartographic[];
}

// Line-of-sight result along one ray of the beam.
interface RayAnalysis {
    // How much of the beam (metres, vertically) terrain hides over each
    // sample, minus MIN_BLOCKED_DEPTH_M: > 0 blocked, < 0 clear. Cleaned so
    // tiny gaps / specks are gone; its zero line is the blocked area's edge.
    blockedScore: Float32Array;
    // Same idea for ground the beam lands on (seen from the antenna and
    // between the min and max angle): > 0 lit, < 0 not lit.
    litScore: Float32Array;
    // Elevation angle (radians) from the antenna down/up to the ground at each
    // sample, and the highest such angle up to and including that sample
    // (-Infinity next to the antenna, which never blocks). A ray at angle a
    // meets the terrain at the first sample where peakAngle >= a.
    groundAngle: Float32Array;
    peakAngle: Float32Array;
    // Ridge (sample index) casting each blocked stretch.
    ridges: number[];
}

// The rays of the beam as one grid: row = ray, column = range sample.
interface RayGrid {
    zone: ResolvedZone;
    wrap: boolean;
    profiles: TerrainProfile[];
    rays: RayAnalysis[];
    // Unwrapped azimuth of each row (degrees).
    rowAz: number[];
    enuMatrix: Cesium.Matrix4;
}

// =============================================================================
// Defaults & tuning
// =============================================================================

// 0 = the blocked area is the ground the beam cannot reach (pure terrain shadow).
export const DEFAULT_TARGET_HEIGHT_AGL_M = 0;
// A radar with no mast set stands on a 10 m mast. With the antenna right on
// the terrain, every 2-3 m bump in the terrain data next to it tilts the
// horizon up by degrees and throws long false shadows.
export const DEFAULT_MAST_HEIGHT_M = 10;

export const DEFAULT_BEAM: Omit<BeamSettings, "targetHeightAgl" | "mastHeight" | "raysAcross"> = {
    azimuthDeg: 0,
    widthDeg: 60,
    range: 20000,
    minElevationDeg: 0,
    maxElevationDeg: 30,
    wallDetailDeg: 2.5,
    raysUp: 12
};

export const DEFAULT_RADAR_STYLE: RadarStyle = {
    beamOpacity: 0.12,
    showBeam: true,
    hitWallOpacity: 0.35,
    blockedOpacity: 0.55,
    showBlocked: true,
    showRays: true
};

const BEAM_RGB = [34, 197, 94];        // #22c55e  top / inside
const BEAM_WALL_RGB = [22, 163, 74];   // #16a34a  sides and far end
const LIT_RGB = [34, 197, 94];         // #22c55e  ground the beam lands on
const GROUND_SHADOW_RGB = [31, 41, 55]; // #1f2937  terrain masked from the beam
const BLOCKED_RGB = [239, 68, 68];     // #ef4444  beam rays that hit terrain
const BEAM_COLOR = Cesium.Color.fromBytes(BEAM_RGB[0], BEAM_RGB[1], BEAM_RGB[2]);
const BLOCKED_COLOR = Cesium.Color.fromBytes(BLOCKED_RGB[0], BLOCKED_RGB[1], BLOCKED_RGB[2]);
const BLOCKED_OUTLINE_COLOR = Cesium.Color.fromCssColorString("#111827");
const RAY_HIT_COLOR = Cesium.Color.fromCssColorString("#f59e0b");   // ray stopped by terrain
const RAY_CLEAR_COLOR = Cesium.Color.fromCssColorString("#bbf7d0"); // ray reaches full range

// World terrain is ~30 m detail in most mountain areas; sampling finer than
// this costs time without adding real accuracy.
const TERRAIN_SAMPLE_SPACING_M = 10;
// Rays across the beam when no azimuth step is set: about this many, but never
// closer than MIN_AZIMUTH_STEP_DEG or further apart than MAX_AZIMUTH_STEP_DEG.
const TARGET_RAYS_ACROSS_BEAM = 240;
const MIN_AZIMUTH_STEP_DEG = 0.1;
const MAX_AZIMUTH_STEP_DEG = 1;
// Terrain profiles kept from earlier builds (most recent last).
const PROFILE_CACHE_SIZE = 8;
const EARTH_RADIUS_M = 6371000;
// Standard radar "4/3 Earth" model: the atmosphere bends the beam slightly
// downward, so it reaches as if the Earth were 4/3 larger (flatter).
const EFFECTIVE_EARTH_RADIUS_M = EARTH_RADIUS_M * 4 / 3;
// Ground closer than this to the antenna never blocks it (the antenna's own
// footing / cleared site; the terrain data is too coarse to trust here).
const NEAR_FIELD_IGNORE_M = 50;
// Terrain only blocks a point if it rises more than this above the straight
// line from the antenna to that point (smaller rises are terrain-data noise).
const RIDGE_TOLERANCE_M = 2;
// A spot only counts as blocked if at least this much of the beam above it
// (vertically) is hidden.
const MIN_BLOCKED_DEPTH_M = 1;
// The blocked score is clamped to +-this, so edges interpolate cleanly.
const SCORE_CLAMP_M = 25;
// Gaps in a blocked stretch shorter than this are filled, and stretches
// shorter than MIN_BLOCKED_RUN_M are dropped, so the area has clean edges.
const BLOCKED_GAP_FILL_M = 30;
const MIN_BLOCKED_RUN_M = 50;
// Largest side of the blocked-area texture, in pixels.
const BLOCKED_TEXTURE_MAX_PX = 2048;
// Beam mesh limits.
const BEAM_MESH_MAX_ROWS = 240;
const BEAM_MAX_LEVELS = 121;
const BEAM_RAY_POINTS = 40;
// Opacity of each beam part, relative to the Beam Opacity setting.
const TOP_ALPHA = 1;
const BOTTOM_ALPHA = 0.6;
const WALL_ALPHA = 0.7;
const END_HIT_ALPHA = 1.6;
// Rays drawn: at most this many, and points along each drawn ray.
const MAX_RAYS_ACROSS = 180;
const MAX_RAYS_UP = 60;
const RAY_LINE_POINTS = 16;
// Drawn rays across the beam when not set: one every this many degrees.
const DEFAULT_RAY_SPACING_DEG = 5;
const BLOCKED_POINT_ALWAYS_VISIBLE_M = 3000;

// =============================================================================
// CesiumRadarCoverage: one beam, cut by terrain, + terrain-blocked area
// =============================================================================

export class CesiumRadarCoverage {
    // The radar's single beam, as a "zone" for the LOS probe.
    public static readonly DEFAULT_3D_ZONES: RadarZoneConfig[] = [
        { name: "Beam", cssColor: "#22c55e", color: BEAM_COLOR }
    ];

    // Geometry of every built radar, keyed by entity id.
    private static readonly geometries = new Map<string, RadarGeometry>();

    static getGeometry(entityId: string): RadarGeometry | undefined {
        return CesiumRadarCoverage.geometries.get(entityId);
    }

    static radarIds(): string[] {
        return Array.from(CesiumRadarCoverage.geometries.keys());
    }

    // Beam settings stored on a radar entity's properties. Older radars kept
    // range and angles per zone; those are used when no beam value is set.
    static beamOf(props: Record<string, any>): BeamSettings {
        const oldZone = "Coverage Zone";
        const widthDeg = props["beamWidthDeg"] ?? DEFAULT_BEAM.widthDeg;
        return {
            azimuthDeg: props["beamAzimuthDeg"] ?? DEFAULT_BEAM.azimuthDeg,
            widthDeg,
            range: props["beamRange"] ?? props["zoneRanges"]?.[oldZone] ?? DEFAULT_BEAM.range,
            minElevationDeg: props["beamMinElevationDeg"] ?? props["zoneElevations"]?.[oldZone]?.min ?? DEFAULT_BEAM.minElevationDeg,
            maxElevationDeg: props["beamMaxElevationDeg"] ?? props["zoneElevations"]?.[oldZone]?.max ?? DEFAULT_BEAM.maxElevationDeg,
            targetHeightAgl: props["targetHeightAgl"] ?? DEFAULT_TARGET_HEIGHT_AGL_M,
            mastHeight: props["antennaMastHeight"] ?? DEFAULT_MAST_HEIGHT_M,
            wallDetailDeg: props["beamWallDetailDeg"] ?? DEFAULT_BEAM.wallDetailDeg,
            raysAcross: props["raysAcross"] ?? Cesium.Math.clamp(
                Math.round(widthDeg / DEFAULT_RAY_SPACING_DEG) + (widthDeg >= 360 ? 0 : 1), 3, MAX_RAYS_ACROSS),
            raysUp: props["raysUp"] ?? DEFAULT_BEAM.raysUp
        };
    }

    static styleOf(props: Record<string, any>): RadarStyle {
        return {
            beamOpacity: props["beamOpacity"] ?? DEFAULT_RADAR_STYLE.beamOpacity,
            showBeam: props["showBeam"] ?? DEFAULT_RADAR_STYLE.showBeam,
            hitWallOpacity: props["hitWallOpacity"] ?? DEFAULT_RADAR_STYLE.hitWallOpacity,
            blockedOpacity: props["blockedOpacity"] ?? DEFAULT_RADAR_STYLE.blockedOpacity,
            showBlocked: props["showBlocked"] ?? DEFAULT_RADAR_STYLE.showBlocked,
            showRays: props["showRays"] ?? DEFAULT_RADAR_STYLE.showRays
        };
    }

    // -------------------------------------------------------------------
    // 1. Main entry point
    // -------------------------------------------------------------------
    static async create3DRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: RadarOptions
    ): Promise<RadarCoverageHandle[]> {
        const handles: RadarCoverageHandle[] = [];
        try {
            await CesiumRadarCoverage.buildRadarZones(viewer, terrainProvider, options, handles);
            return handles;
        } catch (err) {
            // Anything already added to the scene would otherwise stay drawn forever.
            for (const handle of handles) {
                try { handle.dispose(); } catch { }
            }
            throw err;
        }
    }

    private static async buildRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: RadarOptions,
        handles: RadarCoverageHandle[]
    ): Promise<void> {

        const { entityId, longitude, latitude, showBlockedPoints = false } = options;
        const mastHeight = Math.max(0, options.beam.mastHeight);

        // Ground polylines are built synchronously, so the old coverage is only
        // swapped out once the new one is ready to draw (no flicker while dragging).
        await Cesium.GroundPolylinePrimitive.initializeTerrainHeights();

        const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude);
        const [sampled] = await Cesium.sampleTerrainMostDetailed(terrainProvider, [cartographic]);
        const terrainHeight = sampled.height ?? 0;
        const radarHeight = terrainHeight + mastHeight;
        const radarPosition = Cesium.Cartesian3.fromDegrees(longitude, latitude, radarHeight);
        const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(radarPosition);

        // Emitter marker
        const marker = viewer.entities.add({
            position: radarPosition,
            point: {
                pixelSize: 16,
                color: Cesium.Color.BLACK,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 3,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
        (marker as any).radarParentId = entityId;
        // Clicking the radar itself always selects it, even with the LOS probe on.
        (marker as any).isRadarMarker = true;
        handles.push({ dispose: () => viewer.entities.remove(marker) });

        // The beam
        const minDeg = Math.min(options.beam.minElevationDeg, options.beam.maxElevationDeg);
        const maxDeg = Math.max(options.beam.minElevationDeg, options.beam.maxElevationDeg);
        const widthDeg = Cesium.Math.clamp(options.beam.widthDeg, 1, 360);
        const wrap = widthDeg >= 360;
        const zone: ResolvedZone = {
            name: "Beam",
            color: BEAM_COLOR,
            range: Math.max(100, options.beam.range),
            minElevationDeg: minDeg,
            maxElevationDeg: maxDeg,
            azimuthStartDeg: wrap ? 0 : options.beam.azimuthDeg - widthDeg / 2,
            azimuthWidthDeg: widthDeg
        };
        const targetHeightAgl = Math.max(0, options.beam.targetHeightAgl);

        const geometry: RadarGeometry = { radarPosition, radarHeight, enuMatrix, zones: [zone], targetHeightAgl };
        CesiumRadarCoverage.geometries.set(entityId, geometry);
        handles.push({
            dispose: () => {
                // A newer build of the same radar may already have replaced it.
                if (CesiumRadarCoverage.geometries.get(entityId) === geometry) {
                    CesiumRadarCoverage.geometries.delete(entityId);
                }
            }
        });

        // Terrain along every ray of the beam (cached: changing only the
        // angles reuses it, which is what keeps the angle sliders live).
        const azimuthStepDeg = options.azimuthStepDeg ?? Cesium.Math.clamp(
            widthDeg / TARGET_RAYS_ACROSS_BEAM, MIN_AZIMUTH_STEP_DEG, MAX_AZIMUTH_STEP_DEG
        );
        const azimuthsDeg = CesiumRadarCoverage.buildAzimuthList(zone.azimuthStartDeg, widthDeg, azimuthStepDeg);
        const profiles = await CesiumRadarCoverage.getTerrainProfiles(
            terrainProvider,
            `${longitude}|${latitude}|${zone.azimuthStartDeg}|${widthDeg}|${azimuthStepDeg}`,
            radarPosition,
            enuMatrix,
            azimuthsDeg,
            zone.range,
            TERRAIN_SAMPLE_SPACING_M
        );

        // Where the terrain hides the beam, ray by ray.
        const minAngle = Cesium.Math.toRadians(minDeg);
        const maxAngle = Cesium.Math.toRadians(maxDeg);
        const rows = profiles.length;
        const grid: RayGrid = {
            zone,
            wrap,
            profiles,
            rays: profiles.map(profile =>
                CesiumRadarCoverage.analyseRay(profile, radarHeight, minAngle, maxAngle, targetHeightAgl, zone.range)
            ),
            rowAz: profiles.map((_, r) => wrap
                ? (360 * r) / rows
                : zone.azimuthStartDeg + (widthDeg * r) / Math.max(1, rows - 1)),
            enuMatrix
        };

        // The beam in the air, cut by terrain.
        const beam = CesiumRadarCoverage.buildBeam(
            viewer, entityId, grid, radarHeight, minDeg, maxDeg, options.beam.wallDetailDeg
        );
        handles.push(beam);

        // Ground footprint (lit + blocked), draped on the terrain.
        const blocked = CesiumRadarCoverage.buildBlockedArea(viewer, entityId, grid, longitude, latitude);
        handles.push(blocked);

        // The rays themselves, each stopping where it hits the terrain.
        const rayFan = CesiumRadarCoverage.buildRays(
            viewer, grid, radarHeight, minDeg, maxDeg,
            Math.round(Cesium.Math.clamp(options.beam.raysAcross, 1, MAX_RAYS_ACROSS)),
            Math.round(Cesium.Math.clamp(options.beam.raysUp, 1, MAX_RAYS_UP))
        );
        handles.push(rayFan);

        // Ridge markers: the hill top that casts each blocked stretch.
        if (showBlockedPoints) {
            const pointEntities: Cesium.Entity[] = [];
            viewer.entities.suspendEvents();
            grid.rays.forEach((ray, r) => {
                for (const i of new Set(ray.ridges)) {
                    const ground = profiles[r].groundPoints[i];
                    const e = viewer.entities.add({
                        position: Cesium.Cartesian3.fromRadians(ground.longitude, ground.latitude, 10),
                        point: {
                            pixelSize: 7,
                            color: BLOCKED_COLOR,
                            outlineColor: Cesium.Color.WHITE,
                            outlineWidth: 2,
                            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
                            disableDepthTestDistance: BLOCKED_POINT_ALWAYS_VISIBLE_M
                        }
                    });
                    (e as any).radarParentId = entityId;
                    pointEntities.push(e);
                }
            });
            viewer.entities.resumeEvents();
            handles.push({
                dispose: () => {
                    viewer.entities.suspendEvents();
                    for (const e of pointEntities) viewer.entities.remove(e);
                    viewer.entities.resumeEvents();
                }
            });
        }

        const applyStyle = (st: RadarStyle) => {
            beam.setStyle(st);
            blocked.setStyle(st);
            rayFan.setStyle(st);
            viewer.scene.requestRender();
        };
        applyStyle(options.style);
        handles.push({ dispose: () => { }, setStyle: applyStyle });

        viewer.scene.requestRender();
    }

    // -------------------------------------------------------------------
    // 2. Line of sight along one ray: analyseRay
    // -------------------------------------------------------------------
    // Walking outward, the "horizon" is the steepest line from the antenna that
    // still touches terrain so far. At each sample the beam spans
    // [minAngle, maxAngle]:
    //   - ground / peak angle: used to find where each ray meets the terrain.
    //   - blocked: part of the beam above the ground + aircraft height lies
    //     below the horizon, i.e. hidden by nearer terrain.
    //   - lit: the ground itself is above the horizon (seen from the antenna)
    //     and between the min and max angle, so a ray of the beam lands on it.
    // Raising the min angle lifts the beam over low hills, so the blocked area
    // shrinks; lowering it lets more hills cut into the beam.
    private static analyseRay(
        profile: TerrainProfile,
        radarHeight: number,
        minAngle: number,
        maxAngle: number,
        targetHeightAgl: number,
        range: number
    ): RayAnalysis {
        const { horizontalDistances: dists, groundHeights } = profile;
        const n = dists.length;
        const score = new Float32Array(n).fill(-SCORE_CLAMP_M);
        const lit = new Float32Array(n).fill(-SCORE_CLAMP_M);
        const groundAngle = new Float32Array(n).fill(-Math.PI / 2);
        const peakAngle = new Float32Array(n).fill(-Infinity);
        const ridgeOf = new Int32Array(n).fill(-1);
        const minTan = Math.tan(minAngle);
        const maxTan = Math.tan(maxAngle);

        let horizon = -Infinity;
        let ridge = -1;
        for (let i = 1; i < n; i++) {
            const d = dists[i];
            groundAngle[i] = CesiumRadarCoverage.elevationAngle(groundHeights[i], d, radarHeight);
            peakAngle[i] = d < NEAR_FIELD_IGNORE_M ? peakAngle[i - 1] : Math.max(peakAngle[i - 1], groundAngle[i]);
            if (d < NEAR_FIELD_IGNORE_M || d > range) continue;

            const targetTan = Math.tan(CesiumRadarCoverage.elevationAngle(groundHeights[i] + targetHeightAgl, d, radarHeight));
            const hidden = (Math.min(maxTan, horizon) - Math.max(minTan, targetTan)) * d;
            score[i] = Cesium.Math.clamp(hidden - MIN_BLOCKED_DEPTH_M, -SCORE_CLAMP_M, SCORE_CLAMP_M);
            ridgeOf[i] = ridge;

            const groundTan = Math.tan(groundAngle[i]);
            const seen = horizon === -Infinity ? SCORE_CLAMP_M : (groundTan - horizon) * d;
            lit[i] = Cesium.Math.clamp(
                Math.min(seen, (groundTan - minTan) * d, (maxTan - groundTan) * d),
                -SCORE_CLAMP_M, SCORE_CLAMP_M
            );
            // Never both: blocked wins.
            if (score[i] > 0 && lit[i] > 0) lit[i] = -lit[i];

            const h = CesiumRadarCoverage.horizonTan(Math.atan(groundTan), d);
            if (h > horizon) {
                horizon = h;
                ridge = i;
            }
        }

        // Clean: fill tiny gaps, drop tiny stretches.
        const spacing = n > 1 ? dists[1] - dists[0] : TERRAIN_SAMPLE_SPACING_M;
        const maxGap = Math.max(1, Math.round(BLOCKED_GAP_FILL_M / spacing));
        const minRun = Math.max(1, Math.round(MIN_BLOCKED_RUN_M / spacing));
        const ridges: number[] = [];
        let i = 0;
        while (i < n) {
            if (score[i] <= 0) { i++; continue; }
            const from = i;
            let to = i;
            let j = i + 1;
            while (j < n) {
                if (score[j] > 0) { to = j; j++; continue; }
                let k = j;
                while (k < n && score[k] <= 0 && k - to <= maxGap) k++;
                if (k < n && score[k] > 0 && k - to <= maxGap) {
                    for (let g = to + 1; g < k; g++) score[g] = Math.max(score[g], 0.5);
                    j = k;
                    continue;
                }
                break;
            }
            if (to - from + 1 < minRun) {
                for (let g = from; g <= to; g++) score[g] = Math.min(score[g], -0.5);
            } else if (ridgeOf[from] >= 0) {
                ridges.push(ridgeOf[from]);
            }
            i = to + 1;
        }
        return { blockedScore: score, litScore: lit, groundAngle, peakAngle, ridges };
    }

    // Blocked (or lit) score at a fractional (row, column) of the grid, blended
    // from the four nearest samples. Rows outside a sector count as clear.
    private static scoreAt(grid: RayGrid, row: number, col: number, which: "blockedScore" | "litScore" = "blockedScore"): number {
        const rows = grid.rays.length;
        const n = grid.rays[0].blockedScore.length;
        const r0 = Math.floor(row);
        const w = row - r0;
        const c0 = Math.min(Math.floor(col), n - 1);
        const c1 = Math.min(c0 + 1, n - 1);
        const u = col - Math.floor(col);
        const rowScore = (r: number) => {
            if (grid.wrap) r = ((r % rows) + rows) % rows;
            else if (r < 0 || r >= rows) return -SCORE_CLAMP_M;
            const s = grid.rays[r][which];
            return s[c0] * (1 - u) + s[c1] * u;
        };
        return rowScore(r0) * (1 - w) + rowScore(r0 + 1) * w;
    }

    // -------------------------------------------------------------------
    // 3. The ground footprint: buildBlockedArea
    // -------------------------------------------------------------------
    // Fill: an image draped on the terrain (follows every hill exactly); each
    // pixel takes the scores at its own azimuth and distance, blended between
    // the nearest rays and samples, so edges run smoothly between rays instead
    // of stepping ray by ray:
    //   red   = terrain hides this ground from the beam (blocked)
    //   green = a ray of the beam lands on this ground (lit)
    //   clear = the beam passes over it (below the min angle) or out of range.
    // Where a ray grazes a hill top, the green on the hill meets the red behind it.
    // Outline: the same edge (score = 0), traced with marching squares over
    // the ray grid and drawn as lines clamped to the terrain.
    private static buildBlockedArea(
        viewer: Cesium.Viewer,
        entityId: string,
        grid: RayGrid,
        longitude: number,
        latitude: number
    ): RadarCoverageHandle & { setStyle(st: RadarStyle): void } {
        const { zone, wrap, profiles, rays, rowAz } = grid;
        const rows = rays.length;
        const dists = profiles[0].horizontalDistances;
        const n = dists.length;
        const spacing = n > 1 ? dists[1] - dists[0] : TERRAIN_SAMPLE_SPACING_M;
        const range = zone.range;

        // ---- Fill texture over the sector's bounding box ----
        const azList: number[] = [];
        for (let k = 0; k <= 64; k++) azList.push(zone.azimuthStartDeg + (zone.azimuthWidthDeg * k) / 64);
        for (let a = 0; a < 360; a += 90) {
            const rel = (((a - zone.azimuthStartDeg) % 360) + 360) % 360;
            if (wrap || rel <= zone.azimuthWidthDeg) azList.push(a);
        }
        let minE = 0, maxE = 0, minN = 0, maxN = 0;
        for (const az of azList) {
            const rad = Cesium.Math.toRadians(az);
            minE = Math.min(minE, Math.sin(rad) * range);
            maxE = Math.max(maxE, Math.sin(rad) * range);
            minN = Math.min(minN, Math.cos(rad) * range);
            maxN = Math.max(maxN, Math.cos(rad) * range);
        }
        const widthM = Math.max(1, maxE - minE);
        const heightM = Math.max(1, maxN - minN);
        const metersPerPixel = Math.max(widthM, heightM) / BLOCKED_TEXTURE_MAX_PX;
        const px = (m: number) => Math.max(1, Math.min(BLOCKED_TEXTURE_MAX_PX, Math.ceil(m / Math.max(metersPerPixel, spacing / 2))));
        const texW = px(widthM);
        const texH = px(heightM);
        const mppX = widthM / texW;
        const mppY = heightM / texH;

        // WGS84 metres per degree at this latitude.
        const phi = Cesium.Math.toRadians(latitude);
        const metersPerDegLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
        const metersPerDegLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
        const rectangle = Cesium.Rectangle.fromDegrees(
            longitude + minE / metersPerDegLon,
            latitude + minN / metersPerDegLat,
            longitude + maxE / metersPerDegLon,
            latitude + maxN / metersPerDegLat
        );

        const canvas = document.createElement("canvas");
        canvas.width = texW;
        canvas.height = texH;
        const ctx = canvas.getContext("2d")!;
        const image = ctx.createImageData(texW, texH);
        const data = image.data;
        let anyBlocked = false;

        const rowStepDeg = wrap ? 360 / rows : zone.azimuthWidthDeg / Math.max(1, rows - 1);
        for (let y = 0; y < texH; y++) {
            // Row 0 is the north edge.
            const north = maxN - (y + 0.5) * mppY;
            for (let x = 0; x < texW; x++) {
                const east = minE + (x + 0.5) * mppX;
                const dist = Math.hypot(east, north);
                if (dist > range || dist < NEAR_FIELD_IGNORE_M) continue;
                const az = (Cesium.Math.toDegrees(Math.atan2(east, north)) + 360) % 360;
                const rel = (((az - zone.azimuthStartDeg) % 360) + 360) % 360;
                if (!wrap && rel > zone.azimuthWidthDeg) continue;
                const row = rel / rowStepDeg, col = dist / spacing;
                let s = CesiumRadarCoverage.scoreAt(grid, row, col);
                let color = GROUND_SHADOW_RGB;
                if (s <= 0) {
                    s = CesiumRadarCoverage.scoreAt(grid, row, col, "litScore");
                    color = LIT_RGB;
                    if (s <= 0) continue;
                }
                const o = (y * texW + x) * 4;
                data[o] = color[0];
                data[o + 1] = color[1];
                data[o + 2] = color[2];
                // Soft 1-pixel edge.
                data[o + 3] = Math.round(255 * Math.min(1, s / 0.5));
                anyBlocked = true;
            }
        }
        ctx.putImageData(image, 0, 0);

        let fillColor = Cesium.Color.WHITE.withAlpha(DEFAULT_RADAR_STYLE.blockedOpacity);
        const fill = anyBlocked ? viewer.entities.add({
            rectangle: {
                coordinates: rectangle,
                material: new Cesium.ImageMaterialProperty({
                    image: canvas,
                    transparent: true,
                    color: new Cesium.CallbackProperty(() => fillColor, false)
                }),
                classificationType: Cesium.ClassificationType.TERRAIN
            }
        }) : null;
        if (fill) (fill as any).radarParentId = entityId;

        // ---- Outline: marching squares on the ray grid ----
        // Grid nodes: (row r, column i). Rows outside a sector and the column
        // past the range count as clear, so the outline closes along the
        // beam's sides and far end.
        const lastCol = (() => {
            let c = n - 1;
            while (c > 0 && dists[c] > range) c--;
            return c;
        })();
        const scoreNode = (r: number, i: number) => {
            if (i > lastCol) return -SCORE_CLAMP_M;
            if (wrap) r = ((r % rows) + rows) % rows;
            else if (r < 0 || r >= rows) return -SCORE_CLAMP_M;
            return rays[r].blockedScore[i];
        };
        const azOfRow = (r: number) => wrap ? (360 * r) / rows : rowAz[Cesium.Math.clamp(r, 0, rows - 1)];
        const distOfCol = (i: number) => i > lastCol ? range : dists[i];
        const enu = grid.enuMatrix;
        const pointAt = (azDeg: number, d: number) => {
            const az = Cesium.Math.toRadians(azDeg);
            return Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(Math.sin(az) * d, Math.cos(az) * d, 0), new Cesium.Cartesian3());
        };
        // Crossing on the edge between two nodes, by linear interpolation.
        const crossing = (r1: number, i1: number, r2: number, i2: number) => {
            const s1 = scoreNode(r1, i1), s2 = scoreNode(r2, i2);
            const t = s1 === s2 ? 0.5 : s1 / (s1 - s2);
            return pointAt(
                azOfRow(r1) + (azOfRow(r2) - azOfRow(r1)) * t,
                distOfCol(i1) + (distOfCol(i2) - distOfCol(i1)) * t
            );
        };

        // Edge keys: "a r i" = along the ray (r,i)-(r,i+1); "b r i" = across
        // rays (r,i)-(r+1,i).
        const links = new Map<string, string[]>();
        const pointOf = new Map<string, Cesium.Cartesian3>();
        const edgePoint = (key: string) => {
            let p = pointOf.get(key);
            if (!p) {
                const [kind, rs, is] = key.split(" ");
                const r = +rs, i = +is;
                p = kind === "a" ? crossing(r, i, r, i + 1) : crossing(r, i, r + 1, i);
                pointOf.set(key, p);
            }
            return p;
        };
        const link = (k1: string, k2: string) => {
            (links.get(k1) ?? links.set(k1, []).get(k1)!).push(k2);
            (links.get(k2) ?? links.set(k2, []).get(k2)!).push(k1);
        };

        const rFrom = wrap ? 0 : -1;
        const rTo = wrap ? rows - 1 : rows - 1;
        for (let r = rFrom; r <= rTo; r++) {
            for (let i = 0; i <= lastCol; i++) {
                const s00 = scoreNode(r, i) > 0, s01 = scoreNode(r, i + 1) > 0;
                const s10 = scoreNode(r + 1, i) > 0, s11 = scoreNode(r + 1, i + 1) > 0;
                const code = (s00 ? 1 : 0) | (s01 ? 2 : 0) | (s11 ? 4 : 0) | (s10 ? 8 : 0);
                if (code === 0 || code === 15) continue;
                // Cell edges: left = along ray r, right = along ray r+1,
                // bottom = across at column i, top = across at column i+1.
                const L = `a ${r} ${i}`, R = `a ${r + 1} ${i}`, B = `b ${r} ${i}`, T = `b ${r} ${i + 1}`;
                switch (code) {
                    case 1: case 14: link(L, B); break;
                    case 2: case 13: link(L, T); break;
                    case 4: case 11: link(T, R); break;
                    case 8: case 7: link(R, B); break;
                    case 3: case 12: link(B, T); break;
                    case 6: case 9: link(L, R); break;
                    case 5: link(L, B); link(T, R); break;
                    case 10: link(L, T); link(R, B); break;
                }
            }
        }

        // Chain the segments into polylines.
        const chains: Cesium.Cartesian3[][] = [];
        const used = new Set<string>();
        const edgeId = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
        for (const start of links.keys()) {
            for (const first of links.get(start)!) {
                if (used.has(edgeId(start, first))) continue;
                const chain = [edgePoint(start)];
                let prev = start, cur = first;
                used.add(edgeId(prev, cur));
                while (true) {
                    chain.push(edgePoint(cur));
                    const next = (links.get(cur) ?? []).find(k => !used.has(edgeId(cur, k)));
                    if (!next) break;
                    used.add(edgeId(cur, next));
                    prev = cur;
                    cur = next;
                }
                if (chain.length >= 2) chains.push(chain);
            }
        }

        const lineMaterial = Cesium.Material.fromType("Color", { color: BLOCKED_OUTLINE_COLOR });
        const outline = chains.length === 0 ? null : viewer.scene.primitives.add(new Cesium.GroundPolylinePrimitive({
            geometryInstances: chains.map(positions => new Cesium.GeometryInstance({
                geometry: new Cesium.GroundPolylineGeometry({ positions, width: 2 })
            })),
            appearance: new Cesium.PolylineMaterialAppearance({ material: lineMaterial }),
            classificationType: Cesium.ClassificationType.TERRAIN,
            asynchronous: false
        })) as Cesium.GroundPolylinePrimitive | null;

        return {
            dispose: () => {
                if (fill) viewer.entities.remove(fill);
                if (outline) viewer.scene.primitives.remove(outline);
            },
            setStyle: (st: RadarStyle) => {
                const opacity = Cesium.Math.clamp(st.blockedOpacity, 0, 1);
                fillColor = Cesium.Color.WHITE.withAlpha(opacity);
                lineMaterial.uniforms.color = BLOCKED_OUTLINE_COLOR.withAlpha(Math.min(1, opacity + 0.35));
                if (fill) fill.show = st.showBlocked && opacity > 0;
                if (outline) outline.show = st.showBlocked;
            }
        };
    }

    // -------------------------------------------------------------------
    // 4. Ray tracing helpers
    // -------------------------------------------------------------------
    // Last range sample that is within the beam's range.
    private static lastColumn(grid: RayGrid): number {
        const dists = grid.profiles[0].horizontalDistances;
        let c = dists.length - 1;
        while (c > 0 && dists[c] > grid.zone.range) c--;
        return c;
    }

    // Where a ray at `angle` (radians) along grid row r first meets the
    // terrain: the first sample whose ground is at or above the ray, found by
    // binary search on the running highest ground angle, then the exact
    // crossing between that sample and the one before. hit = false: the ray
    // stays above the terrain out to the full range.
    private static rayTip(grid: RayGrid, r: number, angle: number, lastCol: number): { dist: number; hit: boolean } {
        const { peakAngle, groundAngle } = grid.rays[r];
        const dists = grid.profiles[r].horizontalDistances;
        if (!(peakAngle[lastCol] >= angle)) return { dist: dists[lastCol], hit: false };
        let lo = 1, hi = lastCol;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (peakAngle[mid] >= angle) hi = mid;
            else lo = mid + 1;
        }
        const a0 = groundAngle[lo - 1], a1 = groundAngle[lo];
        const t = a1 > a0 ? Cesium.Math.clamp((angle - a0) / (a1 - a0), 0, 1) : 0;
        return { dist: dists[lo - 1] + (dists[lo] - dists[lo - 1]) * t, hit: true };
    }

    // Ground point (lon, lat in radians, terrain height) at a distance along grid row r.
    private static groundAt(grid: RayGrid, r: number, d: number, lastCol: number) {
        const { horizontalDistances: dists, groundHeights: heights, groundPoints: pts } = grid.profiles[r];
        const spacing = dists.length > 1 ? dists[1] - dists[0] : TERRAIN_SAMPLE_SPACING_M;
        const f = Math.min(Math.max(0, d) / spacing, lastCol);
        const i0 = Math.floor(f), i1 = Math.min(i0 + 1, lastCol), u = f - i0;
        return {
            lon: pts[i0].longitude + (pts[i1].longitude - pts[i0].longitude) * u,
            lat: pts[i0].latitude + (pts[i1].latitude - pts[i0].latitude) * u,
            height: heights[i0] + (heights[i1] - heights[i0]) * u
        };
    }

    // -------------------------------------------------------------------
    // 4a. The beam, built from its rays: buildBeam
    // -------------------------------------------------------------------
    // The beam is filled with rays: rows and elevation levels are spaced by
    // wallDetailDeg. Every ray is traced until it meets the terrain (rayTip),
    // or to the full range. The beam's surface joins those rays:
    //   - top face: the max-angle rays of neighbouring directions
    //   - bottom face: the min-angle rays
    //   - end wall: the tip of every ray joined to its neighbours (up/down
    //     and left/right). Where rays stop on the terrain this wall follows
    //     the hills (red); where they run the full range it is the far end
    //     (green). Behind a hill it slants up from the ridge to where the
    //     higher rays end, which is the edge of the terrain shadow.
    //   - side walls (beam < 360°): the rays of the two edge directions.
    private static buildBeam(
        viewer: Cesium.Viewer,
        entityId: string,
        grid: RayGrid,
        radarHeight: number,
        minDeg: number,
        maxDeg: number,
        wallDetailDeg: number
    ): RadarCoverageHandle & { setStyle(st: RadarStyle): void } {
        const { wrap, profiles } = grid;
        const lastCol = CesiumRadarCoverage.lastColumn(grid);

        const desiredRows = wrap
            ? Math.ceil(360 / wallDetailDeg)
            : Math.ceil(grid.zone.azimuthWidthDeg / wallDetailDeg) + 1;
        const rowCount = Math.min(profiles.length, BEAM_MESH_MAX_ROWS, Math.max(wrap ? 3 : 2, desiredRows));
        const rowIdx = Array.from({ length: rowCount }, (_, k) => wrap
            ? Math.floor((k * profiles.length) / rowCount)
            : Math.round((k * (profiles.length - 1)) / Math.max(1, rowCount - 1)));
        const R = rowIdx.length;

        const span = maxDeg - minDeg;
        const M = span < 0.01 ? 1 : Cesium.Math.clamp(
            Math.ceil(span / wallDetailDeg) + 1, 2, BEAM_MAX_LEVELS
        );
        const angles = Array.from({ length: M }, (_, k) =>
            Cesium.Math.toRadians(M === 1 ? maxDeg : minDeg + (span * k) / (M - 1)));
        const C = BEAM_RAY_POINTS;

        // Length and hit of every ray.
        const len = new Float64Array(R * M);
        const hit = new Uint8Array(R * M);
        for (let r = 0; r < R; r++) {
            for (let k = 0; k < M; k++) {
                const tip = CesiumRadarCoverage.rayTip(grid, rowIdx[r], angles[k], lastCol);
                len[r * M + k] = tip.dist;
                hit[r * M + k] = tip.hit ? 1 : 0;
            }
        }

        const positions: number[] = [];
        const rgba: number[] = [];
        const hitWallVertices: boolean[] = [];
        const indices: number[] = [];
        // Point on ray (r, k) at distance d from the antenna.
        const rayPoint = (r: number, k: number, d: number) => {
            const g = CesiumRadarCoverage.groundAt(grid, rowIdx[r], d, lastCol);
            const tipOnGround = hit[r * M + k] && d >= len[r * M + k];
            return Cesium.Cartesian3.fromRadians(g.lon, g.lat,
                tipOnGround ? g.height : CesiumRadarCoverage.beamHeightAt(angles[k], d, radarHeight));
        };
        // A surface over an (a x b) grid of points, joined into triangles.
        const addGrid = (na: number, nb: number, wrapA: boolean,
            pointOf: (a: number, b: number) => Cesium.Cartesian3,
            colorOf: (a: number, b: number) => [number[], number, boolean?]) => {
            const first = positions.length / 3;
            for (let a = 0; a < na; a++) {
                for (let b = 0; b < nb; b++) {
                    const p = pointOf(a, b);
                    const [color, alpha, isHitWall = false] = colorOf(a, b);
                    positions.push(p.x, p.y, p.z);
                    rgba.push(color[0], color[1], color[2], alpha);
                    hitWallVertices.push(isHitWall);
                }
            }
            for (let a = 0; a < (wrapA ? na : na - 1); a++) {
                const a2 = (a + 1) % na;
                for (let b = 0; b < nb - 1; b++) {
                    const p00 = first + a * nb + b, p01 = p00 + 1, p10 = first + a2 * nb + b, p11 = p10 + 1;
                    indices.push(p00, p01, p10, p01, p11, p10);
                }
            }
        };
        const along = (r: number, k: number, j: number) => rayPoint(r, k, (len[r * M + k] * j) / (C - 1));

        // Top face (max angle) and bottom face (min angle).
        addGrid(R, C, wrap, (r, j) => along(r, M - 1, j), () => [BEAM_RGB, TOP_ALPHA]);
        if (M > 1) {
            addGrid(R, C, wrap, (r, j) => along(r, 0, j), () => [BEAM_RGB, BOTTOM_ALPHA]);
            // End wall: every ray tip joined to its neighbours.
            addGrid(R, M, wrap, (r, k) => rayPoint(r, k, len[r * M + k]),
                (r, k) => hit[r * M + k]
                    ? [BLOCKED_RGB, END_HIT_ALPHA, true]
                    : [BEAM_WALL_RGB, WALL_ALPHA]);
            // Side walls.
            if (!wrap) {
                for (const r of [0, R - 1]) {
                    addGrid(M, C, false, (k, j) => along(r, k, j), () => [BEAM_WALL_RGB, WALL_ALPHA]);
                }
            }
        }

        // Edge lines: the tips of the top and bottom rays, and (beam < 360°)
        // the two edge directions' top and bottom rays and tip line.
        let edgeColor = BEAM_COLOR;
        const edgeLines: Cesium.Cartesian3[][] = [];
        const rowsLine = (k: number) => {
            const pts = Array.from({ length: R }, (_, r) => rayPoint(r, k, len[r * M + k]));
            if (wrap) pts.push(pts[0]);
            return pts;
        };
        edgeLines.push(rowsLine(M - 1));
        if (M > 1) edgeLines.push(rowsLine(0));
        if (!wrap) {
            for (const r of [0, R - 1]) {
                edgeLines.push(Array.from({ length: C }, (_, j) => along(r, M - 1, j)));
                if (M > 1) {
                    edgeLines.push(Array.from({ length: C }, (_, j) => along(r, 0, j)));
                    edgeLines.push(Array.from({ length: M }, (_, k) => rayPoint(r, k, len[r * M + k])));
                }
            }
        }
        const edges = edgeLines.map(linePositions => {
            const e = viewer.entities.add({
                polyline: {
                    positions: linePositions,
                    width: 1.5,
                    arcType: Cesium.ArcType.NONE,
                    material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => edgeColor, false))
                }
            });
            (e as any).radarParentId = entityId;
            return e;
        });

        const positionArray = new Float64Array(positions);
        const indexArray = new Uint32Array(indices);
        const vertexCount = positions.length / 3;
        const boundingSphere = Cesium.BoundingSphere.fromVertices(positions);

        let primitive: Cesium.Primitive | null = null;
        let builtOpacity = -1;
        let builtHitWallOpacity = -1;
        let disposed = false;
        const draw = (opacity: number, hitWallOpacity: number) => {
            if (disposed) return;
            if (opacity === builtOpacity && hitWallOpacity === builtHitWallOpacity) return;
            builtOpacity = opacity;
            builtHitWallOpacity = hitWallOpacity;
            if (primitive) viewer.scene.primitives.remove(primitive);
            primitive = null;
            if (indexArray.length === 0 || opacity <= 0) return;
            const colors = new Uint8Array(vertexCount * 4);
            for (let v = 0; v < vertexCount; v++) {
                colors[v * 4] = rgba[v * 4];
                colors[v * 4 + 1] = rgba[v * 4 + 1];
                colors[v * 4 + 2] = rgba[v * 4 + 2];
                const wallOpacity = hitWallVertices[v] ? hitWallOpacity : 1;
                colors[v * 4 + 3] = Math.round(255 * Math.min(1, opacity * rgba[v * 4 + 3] * wallOpacity));
            }
            primitive = viewer.scene.primitives.add(new Cesium.Primitive({
                geometryInstances: new Cesium.GeometryInstance({
                    geometry: new Cesium.Geometry({
                        attributes: {
                            position: new Cesium.GeometryAttribute({
                                componentDatatype: Cesium.ComponentDatatype.DOUBLE,
                                componentsPerAttribute: 3,
                                values: positionArray
                            }),
                            // Per-vertex colour, read by PerInstanceColorAppearance's "color" input.
                            color: new Cesium.GeometryAttribute({
                                componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
                                componentsPerAttribute: 4,
                                normalize: true,
                                values: colors
                            })
                        } as any,
                        indices: indexArray,
                        primitiveType: Cesium.PrimitiveType.TRIANGLES,
                        boundingSphere
                    })
                }),
                appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
                asynchronous: false
            })) as Cesium.Primitive;
        };

        return {
            dispose: () => {
                disposed = true;
                if (primitive) viewer.scene.primitives.remove(primitive);
                primitive = null;
                for (const e of edges) viewer.entities.remove(e);
            },
            setStyle: (st: RadarStyle) => {
                const opacity = Cesium.Math.clamp(st.beamOpacity, 0, 1);
                draw(st.showBeam ? opacity : 0, Cesium.Math.clamp(st.hitWallOpacity, 0, 1));
                edgeColor = BEAM_COLOR.withAlpha(Math.min(1, opacity + 0.5));
                for (const e of edges) e.show = st.showBeam;
            }
        };
    }

    // -------------------------------------------------------------------
    // 4b. The rays drawn on screen: buildRays
    // -------------------------------------------------------------------
    // `across` directions spread over the beam's width, and in each direction
    // `up` rays from the min to the max angle, traced exactly like the beam's
    // own rays (rayTip). A ray stops where it first meets the ground (orange,
    // with a dot at the hit point) or runs to the full range (light green).
    private static buildRays(
        viewer: Cesium.Viewer,
        grid: RayGrid,
        radarHeight: number,
        minDeg: number,
        maxDeg: number,
        across: number,
        up: number
    ): RadarCoverageHandle & { setStyle(st: RadarStyle): void } {
        const { profiles, wrap } = grid;
        const rows = profiles.length;
        const lastCol = CesiumRadarCoverage.lastColumn(grid);

        const rowSet = new Set<number>();
        if (across === 1) rowSet.add(Math.floor(rows / 2));
        else for (let k = 0; k < across; k++) {
            rowSet.add(wrap ? Math.floor((k * rows) / across) : Math.round((k * (rows - 1)) / (across - 1)));
        }
        const angles: number[] = up === 1
            ? [(minDeg + maxDeg) / 2]
            : Array.from({ length: up }, (_, k) => minDeg + ((maxDeg - minDeg) * k) / (up - 1));

        const lines = viewer.scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection;
        const hits = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection;
        // Each polyline needs its own Material: PolylineCollection.destroy()
        // destroys every polyline's material, so a shared one throws on the
        // second polyline and leaves the rest of the old coverage on screen.
        const rayMaterial = (hit: boolean) => Cesium.Material.fromType("Color", {
            color: hit ? RAY_HIT_COLOR.withAlpha(0.95) : RAY_CLEAR_COLOR.withAlpha(0.7)
        });

        for (const r of rowSet) {
            for (const deg of angles) {
                const angle = Cesium.Math.toRadians(deg);
                const tip = CesiumRadarCoverage.rayTip(grid, r, angle, lastCol);
                const positions: Cesium.Cartesian3[] = [];
                for (let k = 0; k <= RAY_LINE_POINTS; k++) {
                    const d = (tip.dist * k) / RAY_LINE_POINTS;
                    const g = CesiumRadarCoverage.groundAt(grid, r, d, lastCol);
                    const h = tip.hit && k === RAY_LINE_POINTS ? g.height : CesiumRadarCoverage.beamHeightAt(angle, d, radarHeight);
                    positions.push(Cesium.Cartesian3.fromRadians(g.lon, g.lat, h));
                }
                lines.add({ positions, width: tip.hit ? 1.6 : 1.1, material: rayMaterial(tip.hit) });

                if (tip.hit) {
                    const g = CesiumRadarCoverage.groundAt(grid, r, tip.dist, lastCol);
                    hits.add({
                        position: Cesium.Cartesian3.fromRadians(g.lon, g.lat, g.height + 2),
                        pixelSize: 5,
                        color: RAY_HIT_COLOR,
                        outlineColor: Cesium.Color.WHITE,
                        outlineWidth: 1,
                        disableDepthTestDistance: BLOCKED_POINT_ALWAYS_VISIBLE_M
                    });
                }
            }
        }

        return {
            dispose: () => {
                viewer.scene.primitives.remove(lines);
                viewer.scene.primitives.remove(hits);
            },
            setStyle: (st: RadarStyle) => {
                lines.show = st.showRays;
                hits.show = st.showRays;
            }
        };
    }

    // -------------------------------------------------------------------
    // 5. Azimuths of the rays across the beam
    // -------------------------------------------------------------------
    private static buildAzimuthList(startDeg: number, sweepDeg: number, stepDeg: number): number[] {
        const sweep = Cesium.Math.clamp(sweepDeg, 1, 360);
        const step = Math.max(0.05, stepDeg);
        const count = Math.max(2, Math.round(sweep / step) + (sweep >= 360 ? 0 : 1));
        const azimuths: number[] = [];
        for (let i = 0; i < count; i++) {
            const raw = startDeg + (sweep * i) / (sweep >= 360 ? count : count - 1);
            azimuths.push(((raw % 360) + 360) % 360);
        }
        return azimuths;
    }

    // -------------------------------------------------------------------
    // 6. Terrain profiles (cached)
    // -------------------------------------------------------------------
    // Sampling terrain is by far the slowest step, and the ground does not change
    // when only the mast height, the beam's angles or a shorter range change.
    // Profiles are therefore kept per radar spot + ray fan, and reused when they
    // already reach far enough.
    private static readonly profileCache = new Map<string, { maxRange: number; profiles: TerrainProfile[] }>();

    private static async getTerrainProfiles(
        terrainProvider: Cesium.TerrainProvider,
        cacheKey: string,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthsDeg: number[],
        maxRange: number,
        spacing: number
    ): Promise<TerrainProfile[]> {
        const cache = CesiumRadarCoverage.profileCache;
        const hit = cache.get(cacheKey);
        if (hit && hit.maxRange >= maxRange) {
            cache.delete(cacheKey);
            cache.set(cacheKey, hit);
            return hit.profiles;
        }

        const profiles = await CesiumRadarCoverage.buildTerrainProfiles(
            terrainProvider, radarPosition, enuMatrix, azimuthsDeg, maxRange, spacing
        );
        cache.delete(cacheKey);
        cache.set(cacheKey, { maxRange, profiles });
        while (cache.size > PROFILE_CACHE_SIZE) {
            cache.delete(cache.keys().next().value!);
        }
        return profiles;
    }

    private static async buildTerrainProfiles(
        terrainProvider: Cesium.TerrainProvider,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthsDeg: number[],
        maxRange: number,
        spacing: number
    ): Promise<TerrainProfile[]> {
        const sampleCount = Math.max(2, Math.ceil(maxRange / spacing)) + 1;
        const horizontalDistances: number[] = [];
        for (let i = 0; i < sampleCount; i++) {
            horizontalDistances.push(Math.min(i * spacing, maxRange));
        }

        const flatCartographics: Cesium.Cartographic[] = [];
        const scratchPoint = new Cesium.Cartesian3();
        for (const azimuthDeg of azimuthsDeg) {
            const groundRay = CesiumRadarCoverage.makeRay(radarPosition, enuMatrix, azimuthDeg, 0);
            for (const distance of horizontalDistances) {
                const point = Cesium.Ray.getPoint(groundRay, distance, scratchPoint);
                flatCartographics.push(Cesium.Cartographic.fromCartesian(point));
            }
        }

        const sampledTerrain = await Cesium.sampleTerrainMostDetailed(terrainProvider, flatCartographics);

        return azimuthsDeg.map((azimuthDeg, a) => {
            const base = a * sampleCount;
            const groundPoints = sampledTerrain.slice(base, base + sampleCount);
            const groundHeights = groundPoints.map(p => p.height ?? 0);
            return { azimuthDeg, horizontalDistances, groundHeights, groundPoints };
        });
    }

    private static makeRay(
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthDeg: number,
        elevationDeg: number
    ): Cesium.Ray {
        const azimuth = Cesium.Math.toRadians(azimuthDeg);
        const elevation = Cesium.Math.toRadians(elevationDeg);
        const localDirection = new Cesium.Cartesian3(
            Math.sin(azimuth) * Math.cos(elevation),
            Math.cos(azimuth) * Math.cos(elevation),
            Math.sin(elevation)
        );
        const worldDirection = Cesium.Matrix4.multiplyByPointAsVector(enuMatrix, localDirection, new Cesium.Cartesian3());
        Cesium.Cartesian3.normalize(worldDirection, worldDirection);
        return new Cesium.Ray(radarPosition, worldDirection);
    }

    // -------------------------------------------------------------------
    // 7. Shared line-of-sight maths (also used by CesiumLosProbe)
    // -------------------------------------------------------------------
    static readonly NEAR_FIELD_IGNORE_M = NEAR_FIELD_IGNORE_M;

    // Slope (tan of the elevation angle) of the lowest line from the antenna
    // that passes no more than RIDGE_TOLERANCE_M below the terrain seen at
    // `angle`, `dist` away. A point further out is hidden by that terrain
    // exactly when its own tan(angle) is below this value.
    static horizonTan(angle: number, dist: number): number {
        return Math.tan(angle) - RIDGE_TOLERANCE_M / dist;
    }

    // Elevation angle from the antenna to ground at this height and distance,
    // with the 4/3-Earth curvature drop applied.
    static elevationAngle(groundHeight: number, dist: number, radarHeight: number): number {
        const curvatureDrop = (dist * dist) / (2 * EFFECTIVE_EARTH_RADIUS_M);
        return Math.atan2(groundHeight - curvatureDrop - radarHeight, dist);
    }

    // Height above the ellipsoid of a straight beam leaving the antenna at this
    // elevation angle, after this horizontal distance (inverse of elevationAngle).
    static beamHeightAt(angle: number, dist: number, radarHeight: number): number {
        return radarHeight + dist * Math.tan(angle) + (dist * dist) / (2 * EFFECTIVE_EARTH_RADIUS_M);
    }

    // Ground point at this azimuth and horizontal distance from the radar.
    static groundPointAt(geometry: RadarGeometry, azimuthDeg: number, dist: number): Cesium.Cartographic {
        const ray = CesiumRadarCoverage.makeRay(geometry.radarPosition, geometry.enuMatrix, azimuthDeg, 0);
        return Cesium.Cartographic.fromCartesian(Cesium.Ray.getPoint(ray, dist));
    }
}
