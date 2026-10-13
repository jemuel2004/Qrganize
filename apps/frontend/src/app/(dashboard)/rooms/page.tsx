import RoomsClient from './RoomsClient';

export default async function RoomsPage({
  searchParams,
}: {
  /** `?open=no-room` opens Classes Without a Room (e.g. from Analytics) */
  searchParams: Promise<{ open?: string | string[] }>;
}) {
  const { open } = await searchParams;
  return <RoomsClient openNoRoom={(Array.isArray(open) ? open[0] : open) === 'no-room'} />;
}
