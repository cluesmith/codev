/**
 * Regression test for #511: STL viewer model origin doesn't match file
 *
 * Bug: Three.js BufferGeometry.translate() auto-updates the bounding box,
 * but the code subtracted center.z from the already-updated min.z, causing
 * a double offset that made models float above the grid plane.
 *
 * Fix: Center only in XY (not Z), then use boundingBox.min.z directly
 * to sit the model on the Z=0 plane.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('STL viewer model origin (#511)', () => {
  const templatePath = resolve(
    import.meta.dirname,
    '../../../templates/3d-viewer.html',
  );
  const html = readFileSync(templatePath, 'utf-8');

  describe('STL geometry centering fixes', () => {
    it('should center only in XY, not Z', () => {
      // The translate call should only move X and Y, leaving Z at 0
      expect(html).toContain('geometry.translate(-center.x, -center.y, 0)');
      // Must NOT center all three axes (the old buggy pattern)
      expect(html).not.toContain(
        'geometry.translate(-center.x, -center.y, -center.z)',
      );
    });

    it('should use boundingBox.min.z directly to sit on grid', () => {
      // After translate() auto-updates the bbox, min.z is already correct
      expect(html).toContain(
        'geometry.translate(0, 0, -geometry.boundingBox.min.z)',
      );
      // Must NOT subtract center.z from min.z (the old double-offset bug)
      expect(html).not.toContain('geometry.boundingBox.min.z - center.z');
    });
  });

  describe('Phong shading', () => {
    it('should compute vertex normals for smooth shading', () => {
      expect(html).toContain('geometry.computeVertexNormals()');
    });
  });

  describe('background color', () => {
    it('should use 30% gray background', () => {
      expect(html).toContain('new THREE.Color(0x4D4D4D)');
      expect(html).toContain('background: #4D4D4D');
    });
  });
});
