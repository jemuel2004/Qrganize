-- ============================================================
-- SEED DATA
-- ============================================================

-- Admin user (password: admin123)
INSERT INTO users (username, email, password_hash, role) VALUES
('admin', 'admin@school.edu', '$2a$10$rQkPgV5W8V6r5e7mXq1Y2OqL4N2zM8Y9xK3J1H0G6F5D4C3B2A1', 'admin')
ON CONFLICT (username) DO NOTHING;

-- Programs
INSERT INTO programs (code, name, department) VALUES
('BSIT', 'Bachelor of Science in Information Technology', 'College of Computing'),
('BSCS', 'Bachelor of Science in Computer Science', 'College of Computing'),
('BSCpE', 'Bachelor of Science in Computer Engineering', 'College of Engineering')
ON CONFLICT (code) DO NOTHING;

-- Curriculums for BSIT 1st Year 1st Semester
INSERT INTO curriculums (program_id, year_level, semester, subject_code, subject_name, lecture_hours, laboratory_hours) VALUES
((SELECT id FROM programs WHERE code = 'BSIT'), '1st Year', '1st Semester', 'IT101', 'Introduction to Computing', 2, 3),
((SELECT id FROM programs WHERE code = 'BSIT'), '1st Year', '1st Semester', 'IT102', 'Programming 1', 3, 2),
((SELECT id FROM programs WHERE code = 'BSIT'), '1st Year', '1st Semester', 'IT103', 'Mathematics in the Modern World', 3, 0),
((SELECT id FROM programs WHERE code = 'BSIT'), '1st Year', '1st Semester', 'IT104', 'Understanding the Self', 3, 0),
((SELECT id FROM programs WHERE code = 'BSIT'), '1st Year', '2nd Semester', 'IT201', 'Data Structures', 3, 0),
((SELECT id FROM programs WHERE code = 'BSIT'), '1st Year', '2nd Semester', 'IT202', 'Web Development 1', 2, 3),
((SELECT id FROM programs WHERE code = 'BSIT'), '2nd Year', '1st Semester', 'IT301', 'Object Oriented Programming', 2, 3),
((SELECT id FROM programs WHERE code = 'BSIT'), '2nd Year', '1st Semester', 'IT302', 'Database Management', 2, 3),
-- BSCS 1st Year 1st Semester
((SELECT id FROM programs WHERE code = 'BSCS'), '1st Year', '1st Semester', 'CS101', 'Introduction to Computer Science', 3, 0),
((SELECT id FROM programs WHERE code = 'BSCS'), '1st Year', '1st Semester', 'CS102', 'Computer Programming 1', 2, 3),
((SELECT id FROM programs WHERE code = 'BSCS'), '1st Year', '1st Semester', 'CS103', 'Mathematics in the Modern World', 3, 0),
((SELECT id FROM programs WHERE code = 'BSCS'), '1st Year', '1st Semester', 'CS104', 'Understanding the Self', 3, 0),
((SELECT id FROM programs WHERE code = 'BSCS'), '1st Year', '1st Semester', 'CS105', 'Purposive Communication', 3, 0),
-- BSCS 1st Year 2nd Semester
((SELECT id FROM programs WHERE code = 'BSCS'), '1st Year', '2nd Semester', 'CS111', 'Computer Programming 2', 2, 3),
((SELECT id FROM programs WHERE code = 'BSCS'), '1st Year', '2nd Semester', 'CS112', 'Discrete Mathematics', 3, 0),
((SELECT id FROM programs WHERE code = 'BSCS'), '1st Year', '2nd Semester', 'CS113', 'Readings in Philippine History', 3, 0),
-- BSCS 2nd Year 1st Semester
((SELECT id FROM programs WHERE code = 'BSCS'), '2nd Year', '1st Semester', 'CS201', 'Data Structures and Algorithms', 2, 3),
((SELECT id FROM programs WHERE code = 'BSCS'), '2nd Year', '1st Semester', 'CS202', 'Object Oriented Programming', 2, 3),
((SELECT id FROM programs WHERE code = 'BSCS'), '2nd Year', '1st Semester', 'CS203', 'Information Management', 2, 3),
-- BSCpE 1st Year 1st Semester
((SELECT id FROM programs WHERE code = 'BSCpE'), '1st Year', '1st Semester', 'CPE101', 'Computer Engineering Fundamentals', 3, 0),
((SELECT id FROM programs WHERE code = 'BSCpE'), '1st Year', '1st Semester', 'CPE102', 'Computer Programming', 2, 3),
((SELECT id FROM programs WHERE code = 'BSCpE'), '1st Year', '1st Semester', 'CPE103', 'Calculus 1', 3, 0),
((SELECT id FROM programs WHERE code = 'BSCpE'), '1st Year', '1st Semester', 'CPE104', 'Physics for Engineers 1', 2, 3),
((SELECT id FROM programs WHERE code = 'BSCpE'), '1st Year', '1st Semester', 'CPE105', 'Mathematics in the Modern World', 3, 0),
-- BSCpE 1st Year 2nd Semester
((SELECT id FROM programs WHERE code = 'BSCpE'), '1st Year', '2nd Semester', 'CPE111', 'Digital Logic Design', 2, 3),
((SELECT id FROM programs WHERE code = 'BSCpE'), '1st Year', '2nd Semester', 'CPE112', 'Calculus 2', 3, 0),
((SELECT id FROM programs WHERE code = 'BSCpE'), '1st Year', '2nd Semester', 'CPE113', 'Physics for Engineers 2', 2, 3),
-- BSCpE 2nd Year 1st Semester
((SELECT id FROM programs WHERE code = 'BSCpE'), '2nd Year', '1st Semester', 'CPE201', 'Data Structures', 2, 3),
((SELECT id FROM programs WHERE code = 'BSCpE'), '2nd Year', '1st Semester', 'CPE202', 'Microprocessors and Microcontrollers', 2, 3),
((SELECT id FROM programs WHERE code = 'BSCpE'), '2nd Year', '1st Semester', 'CPE203', 'Electric Circuits', 3, 0)
ON CONFLICT (program_id, year_level, semester, subject_code) DO NOTHING;

-- Faculty
INSERT INTO faculty (name, employee_id, department, position, designation_type, designation_units) VALUES
('Juan Dela Cruz', 'EMP-001', 'College of Computing', 'Instructor I', 'Minor Designation', 6),
('Maria Santos',   'EMP-002', 'College of Computing', 'Instructor I', 'No Designation', 0),
('Carlo Reyes',    'EMP-003', 'College of Computing', 'Contractual',  'No Designation', 0),
('Ana Gomez',      'EMP-004', 'College of Computing', 'Instructor I', 'Major Designation', 9),
('Ben Torres',     'EMP-005', 'College of Computing', 'Contractual',  'No Designation', 0)
ON CONFLICT (employee_id) DO NOTHING;

-- Rooms
INSERT INTO rooms (room_name, room_type, capacity, building, qr_code_id, status) VALUES
('Lab 1', 'Laboratory', 40, 'Main Building', 'QR-LAB-001', 'Active'),
('Lab 2', 'Laboratory', 40, 'Main Building', 'QR-LAB-002', 'Active'),
('Lab 3', 'Laboratory', 30, 'Annex Building', 'QR-LAB-003', 'Active'),
('Room 101', 'Lecture', 50, 'Main Building', 'QR-LEC-101', 'Active'),
('Room 102', 'Lecture', 50, 'Main Building', 'QR-LEC-102', 'Active'),
('Room 201', 'Lecture', 45, 'Main Building', 'QR-LEC-201', 'Active'),
('Room 202', 'Lecture', 45, 'Main Building', 'QR-LEC-202', 'Active')
ON CONFLICT (qr_code_id) DO NOTHING;

-- Block for BSIT 1st Year 1st Semester AY 2025-2026
INSERT INTO blocks (program_id, year_level, semester, academic_year, block_name, number_of_students) VALUES
((SELECT id FROM programs WHERE code = 'BSIT'), '1st Year', '1st Semester', '2025-2026', 'A', 40),
((SELECT id FROM programs WHERE code = 'BSIT'), '1st Year', '1st Semester', '2025-2026', 'B', 38),
((SELECT id FROM programs WHERE code = 'BSIT'), '1st Year', '2nd Semester', '2025-2026', 'A', 40)
ON CONFLICT (program_id, year_level, semester, academic_year, block_name) WHERE is_active = true DO NOTHING;
