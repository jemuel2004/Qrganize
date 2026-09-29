import FacultySchedulesClient from './FacultySchedulesClient';

function firstQueryValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? '';
  return value?.trim() ?? '';
}

export default async function FacultySchedulesPage({
  searchParams,
}: {
  searchParams: Promise<{
    facultyId?: string | string[];
    instructorId?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const initialFacultyQuery =
    firstQueryValue(params.facultyId) || firstQueryValue(params.instructorId);

  return <FacultySchedulesClient initialFacultyQuery={initialFacultyQuery} />;
}
