import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, PageHeader, Panel, Pill, Screen } from "../../src/components/ui";
import { remoteFetch } from "../../src/lib/remote";
import { useRemote } from "../../src/providers/RemoteProvider";

type Provider = { provider: string; display_name: string; launch: boolean; streaming: boolean; persistent_sessions: boolean; native_resume: boolean; interactive_approvals: boolean; remote_resume: boolean; integration_mode: string; notes: string };
const features: Array<[keyof Provider,string]> = [["launch","Execução"],["streaming","Streaming"],["persistent_sessions","Sessões persistentes"],["native_resume","Retomada nativa"],["interactive_approvals","Aprovações interativas"],["remote_resume","Retomada remota"]];
export default function ProvidersScreen(){
 const insets=useSafeAreaInsets(); const {connection}=useRemote(); const [items,setItems]=useState<Provider[]>([]); const [error,setError]=useState<string|null>(null); const [refreshing,setRefreshing]=useState(false);
 const refresh=useCallback(async()=>{ if(!connection)return; setRefreshing(true); try{setItems(await remoteFetch<Provider[]>("/api/v1/providers"));setError(null);}catch(e){setError(String(e));}finally{setRefreshing(false);} },[connection]);
 useEffect(()=>{void refresh();},[refresh]);
 return <Screen><ScrollView className="flex-1 px-5" contentContainerStyle={{paddingTop:Math.max(insets.top,16)+8,paddingBottom:28}} refreshControl={<RefreshControl tintColor="#c4b5fd" refreshing={refreshing} onRefresh={()=>void refresh()}/> }>
 <PageHeader eyebrow="PROVIDER RUNTIME" title="Provedores" subtitle="Capacidades realmente integradas no computador pareado."/>
 {!connection?<EmptyState title="Conecte um Host" detail="Pareie o aplicativo para consultar os provedores."/>:items.map(p=><Panel key={p.provider} className="mb-3"><Text className="text-sm font-semibold text-white">{p.display_name}</Text><Text className="mt-1 text-[10px] text-muted">{p.integration_mode}</Text><View className="mt-3 flex-row flex-wrap gap-2">{features.map(([key,label])=><Pill key={key} tone={p[key]?"green":"amber"}>{p[key]?"✓ ":"— "}{label}</Pill>)}</View><Text className="mt-3 text-xs leading-5 text-muted">{p.notes}</Text></Panel>)}
 {error?<Text className="text-xs text-rose-300">{error}</Text>:null}
 </ScrollView></Screen>
}
