import { useState, useEffect, useCallback } from 'react';
import { endpoints } from '@/constants/api';

export interface Listing {
  id: string;
  title: string;
  description: string;
  type: string;
  condition: string;
  price: number;
  currency: string;
  province: string;
  city: string;
  address?: string;
  bedrooms?: number;
  bathrooms?: number;
  area?: number;
  area_unit?: string;
  images: string[];
  blueprints?: string[];
  tags?: string[];
  agencies?: { name: string; email?: string; phone?: string; logo?: string }[];
  construction_company?: string | { name: string; [key: string]: any };
  units_total?: number;
  units_available?: number;
  unit_types?: UnitType[];
  approvedAt?: string;
  submittedAt?: string;
}

export interface UnitType {
  name: string;
  bedrooms: number;
  bathrooms: number;
  area: number;
  price: number;
  total: number;
  available: number;
}

export interface ListingsFilters {
  province?: string;
  city?: string;
  type?: string;
  condition?: string;
  priceMin?: string;
  priceMax?: string;
  bedroomsMin?: string;
  agency?: string;
  constructora?: string;
  page?: number;
  limit?: number;
}

export function useListings(filters: ListingsFilters = {}) {
  const [listings, setListings]   = useState<Listing[]>([]);
  const [total, setTotal]         = useState(0);
  const [pages, setPages]         = useState(1);
  const [loading, setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [page, setPage]           = useState(1);

  const buildUrl = useCallback((p: number) => {
    const params = new URLSearchParams();
    if (filters.province)    params.set('province',    filters.province);
    if (filters.city)        params.set('city',        filters.city);
    if (filters.type)        params.set('type',        filters.type);
    if (filters.condition)   params.set('condition',   filters.condition);
    if (filters.priceMin)    params.set('priceMin',    filters.priceMin);
    if (filters.priceMax)    params.set('priceMax',    filters.priceMax);
    if (filters.bedroomsMin) params.set('bedroomsMin', filters.bedroomsMin);
    if (filters.agency)      params.set('agency',      filters.agency);
    if (filters.constructora)params.set('constructora',filters.constructora);
    params.set('page',  String(p));
    params.set('limit', String(filters.limit || 20));
    return `${endpoints.listings}?${params}`;
  }, [filters]);

  const load = useCallback(async (reset = false) => {
    const p = reset ? 1 : page;
    if (reset) setPage(1);
    reset ? setLoading(true) : setLoadingMore(true);
    setError(null);
    try {
      const res  = await fetch(buildUrl(p));
      const data = await res.json();
      if (reset) {
        setListings(data.listings || []);
      } else {
        setListings(prev => [...prev, ...(data.listings || [])]);
      }
      setTotal(data.total || 0);
      setPages(data.pages || 1);
    } catch {
      setError('No se pudo cargar. Verifica tu conexión.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [buildUrl, page]);

  // Reset when filters change
  useEffect(() => {
    setPage(1);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)]);

  const loadMore = useCallback(() => {
    if (loadingMore || page >= pages) return;
    const next = page + 1;
    setPage(next);
    setLoadingMore(true);
    fetch(buildUrl(next))
      .then(r => r.json())
      .then(data => {
        setListings(prev => [...prev, ...(data.listings || [])]);
        setPages(data.pages || 1);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [loadingMore, page, pages, buildUrl]);

  return { listings, total, loading, loadingMore, error, page, pages, loadMore, reload: () => load(true) };
}
