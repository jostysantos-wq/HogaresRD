export const colors = {
  primary:    '#002D62',
  accent:     '#2563EB',
  accentLight:'#EFF6FF',
  bg:         '#F8FAFC',
  surface:    '#FFFFFF',
  border:     '#D0DCEA',
  text:       '#1A2E44',
  textMuted:  '#4D6A8A',
  textLight:  '#8BA4BC',
  success:    '#16A34A',
  danger:     '#DC2626',
  tag:        '#E8F0FB',
  tagText:    '#1E40AF',
};

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
};

export const shadow = {
  sm: {
    shadowColor: '#1A2E44',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: '#1A2E44',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.10,
    shadowRadius: 8,
    elevation: 4,
  },
};

export const TYPE_LABELS: Record<string, string> = {
  apartamento:        'Apartamento',
  casa:               'Casa',
  villa:              'Villa',
  penthouse:          'Penthouse',
  solar:              'Solar / Terreno',
  local_comercial:    'Local Comercial',
  oficina:            'Oficina',
  proyecto:           'Proyecto',
  nueva_construccion: 'Nueva Construcción',
  planos:             'En Planos',
};

export const CONDITION_LABELS: Record<string, string> = {
  venta:   'Venta',
  alquiler:'Alquiler',
  planos:  'En Planos',
  nueva_construccion: 'Nueva Construcción',
};

export const CONDITION_COLORS: Record<string, string> = {
  venta:              '#002D62',
  alquiler:           '#065F46',
  nueva_construccion: '#7C3AED',
  planos:             '#B45309',
};

// ── iOS 26 Liquid Glass tokens ───────────────────────────────────
export const glass = {
  // Light glass (over light backgrounds)
  lightBg:      'rgba(255, 255, 255, 0.55)',
  lightBorder:  'rgba(255, 255, 255, 0.75)',
  lightHighlight:'rgba(255, 255, 255, 0.9)',
  // Dark/tinted glass (primary actions)
  darkBg:       'rgba(0, 45, 98, 0.72)',
  darkBorder:   'rgba(255, 255, 255, 0.22)',
  // Neutral glass (cards, sheets)
  neutralBg:    'rgba(248, 250, 252, 0.65)',
  neutralBorder:'rgba(255, 255, 255, 0.60)',
  // Blur intensities
  tabBar:       85,
  button:       60,
  card:         40,
  // Shadow for glass elements
  shadow: {
    shadowColor: '#1A2E44',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
};

export const PROVINCES = [
  'Distrito Nacional','Santiago','La Altagracia','Puerto Plata',
  'San Pedro de Macorís','La Romana','Samaná','Santo Domingo',
  'Espaillat','La Vega',
];
