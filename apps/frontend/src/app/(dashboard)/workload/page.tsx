import WorkloadClient from './WorkloadClient';

function firstQueryValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? '';
  return value?.trim() ?? '';
}

export default async function WorkloadPage({
  searchParams,
}: {
  searchParams: Promise<{
    facultyId?: string | string[];
    instructorId?: string | string[];
    assign?: string | string[];
    block?: string | string[];
    from?: string | string[];
    /** Faculty list filter to open on — e.g. the Dashboard's "Incomplete Faculty Load" → unassigned */
    show?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const initialFacultyQuery =
    firstQueryValue(params.facultyId) || firstQueryValue(params.instructorId);
  const show = firstQueryValue(params.show);

  return (
    <WorkloadClient
      initialFacultyQuery={initialFacultyQuery}
      initialAssignFilter={show === 'unassigned' || show === 'assigned' ? show : 'all'}
      assignMsId={Number(firstQueryValue(params.assign)) || null}
      assignBlockId={Number(firstQueryValue(params.block)) || null}
      assignFrom={firstQueryValue(params.from) === 'block' ? 'block' : 'master-schedule'}
    />
  );
}
