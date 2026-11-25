import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CoordinatorScreen } from "./client/coordinator-screen";
import { CoordinatorSidebarItem, SCREEN_ID } from "./client/sidebar-item";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: SCREEN_ID, title: "Coordinator", Component: CoordinatorScreen });
  client.addSidebarHeaderItem({ id: SCREEN_ID, title: "Coordinator", Component: CoordinatorSidebarItem });
  return () => {};
}
