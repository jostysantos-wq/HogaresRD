/* eslint-disable */
import * as Router from 'expo-router';

export * from 'expo-router';

declare module 'expo-router' {
  export namespace ExpoRouter {
    export interface __routes<T extends string = string> extends Record<string, unknown> {
      StaticRoutes: `/` | `/(tabs)` | `/(tabs)/` | `/(tabs)/alquilar` | `/(tabs)/buscar` | `/(tabs)/comprar` | `/(tabs)/proyectos` | `/_sitemap` | `/alquilar` | `/buscar` | `/comprar` | `/proyectos`;
      DynamicRoutes: `/inmobiliaria/${Router.SingleRoutePart<T>}` | `/listing/${Router.SingleRoutePart<T>}`;
      DynamicRouteTemplate: `/inmobiliaria/[slug]` | `/listing/[id]`;
    }
  }
}
