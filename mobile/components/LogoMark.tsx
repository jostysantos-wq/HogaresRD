/**
 * LogoMark — HogaresRD
 *
 * Inspired by Dominican "cuadros típicos" — the mata de palma / flamboyán
 * tree silhouettes that appear in traditional Dominican naive paintings
 * (like those of Mariano Lara or popular Haitian-Dominican primitivism).
 *
 * Mark:  A spreading palm tree whose trunk rises from a minimal bohío
 *        (thatched-roof house) silhouette — nature and home unified.
 *
 * Colors from the Dominican flag:
 *   DR_RED  #CE1126  — tree canopy (like the flamboyán)
 *   DR_BLUE #002D62  — trunk, house, wordmark
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, G } from 'react-native-svg';

const DR_RED  = '#CE1126';
const DR_BLUE = '#002D62';

interface Props {
  size?:     number;   // icon height, default 48
  showName?: boolean;
  light?:    boolean;  // invert for dark backgrounds
}

/**
 * The SVG mark is drawn on a 64×80 coordinate grid.
 * Scale it to any size via the `size` prop.
 */
const VIEWBOX_W = 64;
const VIEWBOX_H = 80;

export default function LogoMark({ size = 48, showName = false, light = false }: Props) {
  const w         = (size / VIEWBOX_H) * VIEWBOX_W;
  const trunkColor = light ? '#fff' : DR_BLUE;
  const houseColor = light ? '#fff' : DR_BLUE;
  const nameColor  = light ? '#fff' : DR_BLUE;

  return (
    <View style={styles.row}>

      {/* ── SVG Mark ──────────────────────────────────────────── */}
      <Svg width={w} height={size} viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}>

        {/*
          ── Fronds ─────────────────────────────────────────────
          7 spreading fronds radiate from trunk top at ~(32, 22).
          Each frond is a closed leaf-shaped quadratic bezier path.
          Colored DR_RED to evoke the flamboyán canopy.
        */}
        <G fill={DR_RED}>
          {/* Far left drooping */}
          <Path d="M32,22 Q12,26 6,38 Q14,30 32,22Z" />
          {/* Left */}
          <Path d="M32,22 Q10,16 4,6 Q14,14 32,22Z" />
          {/* Upper left */}
          <Path d="M32,22 Q20,6 18,0 Q24,8 32,22Z" />
          {/* Upper center (nearly vertical) */}
          <Path d="M32,22 Q30,4 28,0 Q32,6 32,22Z" />
          {/* Upper right */}
          <Path d="M32,22 Q42,4 46,0 Q42,8 32,22Z" />
          {/* Right */}
          <Path d="M32,22 Q52,14 60,4 Q52,14 32,22Z" />
          {/* Far right drooping */}
          <Path d="M32,22 Q52,26 58,38 Q50,28 32,22Z" />
        </G>

        {/*
          ── Trunk ──────────────────────────────────────────────
          Slightly curved — palms lean in the Caribbean breeze.
          Wider at the base, tapering toward the frond crown.
        */}
        <Path
          d="M29,22 Q27,38 28,54 L34,54 Q34,38 35,22Z"
          fill={trunkColor}
        />

        {/*
          ── Bohío silhouette ────────────────────────────────────
          A wide, low-pitched thatched-roof triangle at the base
          — the same roof shape found in Dominican naive paintings.
          The trunk rises from behind it.
        */}
        <Path
          d="M16,70 L32,58 L48,70Z"
          fill={houseColor}
        />
        {/* Tiny door gap (white / transparent) */}
        <Path
          d="M29,70 Q32,65 35,70Z"
          fill={light ? DR_BLUE : '#fff'}
        />

        {/*
          ── Ground line ─────────────────────────────────────────
          A short horizontal stroke anchors the composition —
          the horizon line common in Dominican landscape paintings.
        */}
        <Path
          d="M10,71 L54,71"
          stroke={houseColor}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </Svg>

      {/* ── Wordmark ──────────────────────────────────────────── */}
      {showName && (
        <View style={[styles.wordmarkWrap, { marginLeft: Math.round(size * 0.18) }]}>
          <Text style={[styles.brand, { color: nameColor, fontSize: Math.round(size * 0.36) }]}>
            hogares
          </Text>
          <View style={styles.rdLine}>
            <Text style={[styles.rdText, { fontSize: Math.round(size * 0.28) }]}>
              RD
            </Text>
            {/* Short red rule under RD — echoes the ground horizon */}
            <View style={[styles.rule, { backgroundColor: DR_RED }]} />
          </View>
        </View>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems:    'center',
  },
  wordmarkWrap: {
    justifyContent: 'center',
  },
  brand: {
    fontWeight:    '300',
    letterSpacing: 2,
    textTransform: 'lowercase',
  },
  rdLine: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           6,
    marginTop:     1,
  },
  rdText: {
    color:         DR_RED,
    fontWeight:    '900',
    letterSpacing: 3,
  },
  rule: {
    flex:         1,
    height:       1.5,
    borderRadius: 1,
    minWidth:     18,
  },
});
