import { describe, expect, it } from 'vitest';
import {
    clampDomain,
    hitTestCurves,
    interpolateAtTime,
    nearestPoint,
    panDomain,
    pixelXAtTime,
    timeAtPixel,
    zoomDomainAt,
    type CurveSeries,
    type PlotRect,
} from './chartGesture';

const DAY = 24 * 3600 * 1000;
const rect: PlotRect = { left: 100, top: 20, width: 800, height: 400 };
const bounds = { minTime: 0, maxTime: 10 * DAY, minZoom: DAY };
const curve: CurveSeries = {
    points: [
        { time: 0, value: 0 },
        { time: 5 * DAY, value: 100 },
        { time: 10 * DAY, value: 0 },
    ],
    yDomain: [0, 100],
};

describe('chartGesture domain helpers', () => {
    it('round-trips a time through the plot x coordinate', () => {
        const time = 4 * DAY;
        expect(timeAtPixel(pixelXAtTime(time, rect, [0, 10 * DAY]), rect, [0, 10 * DAY]))
            .toBeCloseTo(time);
    });

    it('enforces the minimum zoom and data bounds', () => {
        expect(clampDomain([2 * DAY, 2.25 * DAY], bounds)).toEqual([2 * DAY, 3 * DAY]);
        expect(clampDomain([-2 * DAY, 4 * DAY], bounds)).toEqual([0, 6 * DAY]);
        expect(clampDomain([0, 20 * DAY], bounds)).toEqual([0, 10 * DAY]);
    });

    it('pans in the opposite direction of the finger drag', () => {
        const next = panDomain([2 * DAY, 5 * DAY], 80, rect.width, bounds);
        expect(next[0]).toBeCloseTo(1.7 * DAY);
        expect(next[1]).toBeCloseTo(4.7 * DAY);
    });

    it('zooms around the supplied anchor time', () => {
        const next = zoomDomainAt([2 * DAY, 8 * DAY], 5 * DAY, 2, bounds);
        expect(next).toEqual([3.5 * DAY, 6.5 * DAY]);
    });
});

describe('chartGesture curve helpers', () => {
    it('linearly interpolates between curve points', () => {
        expect(interpolateAtTime(curve.points, 2.5 * DAY)).toBe(50);
    });

    it('returns the closest chart point for a touch tooltip', () => {
        const points = [
            { time: 0, value: 10 },
            { time: 5, value: 20 },
            { time: 10, value: 30 },
        ];
        expect(nearestPoint(points, 7)).toEqual({ index: 1, time: 5, value: 20 });
        expect(nearestPoint(points, 9)).toEqual({ index: 2, time: 10, value: 30 });
        expect(nearestPoint([], 9)).toBeNull();
    });

    it('hits a curve within the touch tolerance and rejects blank space', () => {
        const x = pixelXAtTime(5 * DAY, rect, [0, 10 * DAY]);
        const y = rect.top;
        expect(hitTestCurves(x, y + 18, rect, [0, 10 * DAY], [curve], 24)).not.toBeNull();
        expect(hitTestCurves(x, y + 40, rect, [0, 10 * DAY], [curve], 24)).toBeNull();
    });
});
