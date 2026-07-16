export interface PlotRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface CurvePoint {
    time: number;
    value: number;
}

export interface CurveSeries {
    points: CurvePoint[];
    yDomain: [number, number];
}

export interface DomainBounds {
    minTime: number;
    maxTime: number;
    minZoom: number;
}

export interface CurveHit {
    time: number;
    distancePx: number;
}

export function clampDomain(domain: [number, number], bounds: DomainBounds): [number, number] {
    const maxZoom = Math.max(bounds.maxTime - bounds.minTime, bounds.minZoom);
    const requestedWidth = Math.max(0, domain[1] - domain[0]);
    const width = Math.max(bounds.minZoom, Math.min(requestedWidth, maxZoom));
    let start = domain[0];
    let end = start + width;

    if (start < bounds.minTime) {
        start = bounds.minTime;
        end = start + width;
    }
    if (end > bounds.maxTime) {
        end = bounds.maxTime;
        start = end - width;
    }
    return [start, end];
}

export function timeAtPixel(pixelX: number, rect: PlotRect, domain: [number, number]): number {
    if (rect.width <= 0 || domain[1] <= domain[0]) return domain[0];
    const ratio = (pixelX - rect.left) / rect.width;
    return domain[0] + ratio * (domain[1] - domain[0]);
}

export function pixelXAtTime(time: number, rect: PlotRect, domain: [number, number]): number {
    if (domain[1] <= domain[0]) return rect.left;
    return rect.left + ((time - domain[0]) / (domain[1] - domain[0])) * rect.width;
}

export function pixelYAtValue(value: number, rect: PlotRect, yDomain: [number, number]): number {
    if (yDomain[1] <= yDomain[0]) return rect.top + rect.height;
    const ratio = (value - yDomain[0]) / (yDomain[1] - yDomain[0]);
    return rect.top + rect.height * (1 - ratio);
}

export function interpolateAtTime(points: CurvePoint[], time: number): number | undefined {
    if (points.length === 0) return undefined;
    if (time <= points[0].time) return points[0].value;
    const last = points[points.length - 1];
    if (time >= last.time) return last.value;

    let low = 0;
    let high = points.length - 1;
    while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (points[mid].time <= time) low = mid;
        else high = mid;
    }
    const span = points[high].time - points[low].time;
    const fraction = span > 0 ? (time - points[low].time) / span : 0;
    return points[low].value + (points[high].value - points[low].value) * fraction;
}

export function nearestPoint(
    points: CurvePoint[],
    time: number,
): { index: number; time: number; value: number } | null {
    if (points.length === 0) return null;
    if (time <= points[0].time) return { index: 0, ...points[0] };
    const lastIndex = points.length - 1;
    if (time >= points[lastIndex].time) return { index: lastIndex, ...points[lastIndex] };

    let low = 0;
    let high = lastIndex;
    while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (points[mid].time <= time) low = mid;
        else high = mid;
    }
    const lowDistance = Math.abs(points[low].time - time);
    const highDistance = Math.abs(points[high].time - time);
    const index = highDistance < lowDistance ? high : low;
    return { index, ...points[index] };
}

export function panDomain(
    domain: [number, number],
    deltaPixels: number,
    plotWidth: number,
    bounds: DomainBounds,
): [number, number] {
    if (plotWidth <= 0) return domain;
    const offset = -(deltaPixels / plotWidth) * (domain[1] - domain[0]);
    return clampDomain([domain[0] + offset, domain[1] + offset], bounds);
}

export function zoomDomainAt(
    domain: [number, number],
    anchorTime: number,
    zoomFactor: number,
    bounds: DomainBounds,
): [number, number] {
    if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return domain;
    const anchor = Math.max(domain[0], Math.min(anchorTime, domain[1]));
    const start = anchor - (anchor - domain[0]) / zoomFactor;
    const end = anchor + (domain[1] - anchor) / zoomFactor;
    return clampDomain([start, end], bounds);
}

export function hitTestCurves(
    pixelX: number,
    pixelY: number,
    rect: PlotRect,
    xDomain: [number, number],
    curves: CurveSeries[],
    tolerancePx: number,
): CurveHit | null {
    if (rect.width <= 0 || rect.height <= 0 || curves.length === 0) return null;
    const time = timeAtPixel(pixelX, rect, xDomain);
    let closest: CurveHit | null = null;

    for (const curve of curves) {
        const value = interpolateAtTime(curve.points, time);
        if (value === undefined) continue;
        const curveY = pixelYAtValue(value, rect, curve.yDomain);
        const distancePx = Math.abs(pixelY - curveY);
        if (distancePx <= tolerancePx && (!closest || distancePx < closest.distancePx)) {
            closest = { time, distancePx };
        }
    }
    return closest;
}
