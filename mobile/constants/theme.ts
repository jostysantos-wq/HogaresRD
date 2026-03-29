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

export const PROVINCES = [
  'Distrito Nacional','Santiago','La Altagracia','Puerto Plata',
  'San Pedro de Macorís','La Romana','Samaná','Santo Domingo',
  'Espaillat','La Vega',
];
